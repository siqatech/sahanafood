import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { Money } from '@sahana/domain';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import { PG_POOL } from '../../../database/database.module.js';
import { ValidationError } from '../../../common/errors.js';

/**
 * Analítica básica: rentabilidad por marca y canal (spec 16, T4.29).
 *
 * La regla de la spec manda y no es purismo: **se lee de PROYECCIONES
 * alimentadas por eventos, nunca de las tablas transaccionales en caliente.**
 * Un `GROUP BY` sobre `ord_orders` a las 20:30 de un viernes compite por las
 * mismas filas que están cerrando pedidos — el panel se pone lento y, peor,
 * pone lenta la caja. Y un dueño mirando su rentabilidad un viernes por la
 * noche es exactamente el caso que hay que soportar.
 *
 * La otra regla de la spec: **todo número monetario del panel tiene que cuadrar
 * con Billing**, y una divergencia es un bug crítico. Por eso existe
 * `reconcileWithBilling()` y por eso hay una prueba que la ejecuta.
 */

export interface BrandChannelProfitability {
  brandId: string;
  brandName: string;
  channel: string;
  orders: number;
  cancelled: number;
  /** Importes como cadena decimal: no pasan por coma flotante en ningún punto. */
  grossRevenue: string;
  discounts: string;
  netRevenue: string;
  commission: string;
  foodCost: string;
  /** Ingreso neto − comisión − food cost. Se CALCULA al leer, no se guarda. */
  contributionMargin: string;
  /** Margen sobre ingreso neto, en puntos básicos. */
  marginBps: number;
  averageTicket: string;
}

export interface ReconciliationResult {
  businessDate: string;
  analyticsTotal: string;
  billingTotal: string;
  difference: string;
  matches: boolean;
  /** Pedidos con venta contada pero sin comprobante aceptado, y al revés. */
  ordersWithoutDocument: number;
  documentsWithoutSale: number;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Alimentación de la proyección
  // -------------------------------------------------------------------------

  /**
   * Suma un pedido aceptado a la proyección del día.
   *
   * Idempotente por `(order_id, 'sale')`: reprocesar un evento no puede sumar
   * la misma venta dos veces. El `inbox` del consumidor ya lo evita, pero un
   * reproceso manual —o un segundo consumidor añadido mañana— no pasa por él,
   * y aquí la garantía es de la tabla.
   */
  async recordSale(
    ctx: TenantContext,
    orderId: string,
  ): Promise<{ counted: boolean }> {
    const pedido = await this.cargarPedido(ctx, orderId);
    if (!pedido) return { counted: false };

    const { rowCount } = await ctx.client.query(
      `INSERT INTO ana_counted_orders (tenant_id, order_id, fact, business_date)
       VALUES ($1,$2,'sale',$3)
       ON CONFLICT (tenant_id, order_id, fact) DO NOTHING`,
      [ctx.tenantId, orderId, pedido.business_date],
    );
    if (rowCount === 0) return { counted: false };

    await ctx.client.query(
      `INSERT INTO ana_daily_sales
         (tenant_id, business_date, brand_id, location_id, channel,
          orders, gross_revenue, discounts, delivery_fees, tips, tax,
          commission_estimated, currency)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, business_date, brand_id, location_id, channel)
       DO UPDATE SET
         orders = ana_daily_sales.orders + 1,
         gross_revenue = ana_daily_sales.gross_revenue + EXCLUDED.gross_revenue,
         discounts = ana_daily_sales.discounts + EXCLUDED.discounts,
         delivery_fees = ana_daily_sales.delivery_fees + EXCLUDED.delivery_fees,
         tips = ana_daily_sales.tips + EXCLUDED.tips,
         tax = ana_daily_sales.tax + EXCLUDED.tax,
         commission_estimated = ana_daily_sales.commission_estimated
                                + EXCLUDED.commission_estimated,
         updated_at = now()`,
      [
        ctx.tenantId,
        pedido.business_date,
        pedido.brand_id,
        pedido.location_id,
        pedido.channel,
        pedido.total,
        pedido.discount_total,
        pedido.delivery_fee,
        pedido.tip,
        pedido.tax,
        pedido.commission_estimated,
        pedido.currency,
      ],
    );

    return { counted: true };
  }

  /**
   * Suma el costo teórico de los insumos consumidos (viene del kardex de
   * T4.25).
   *
   * Va SEPARADO de la venta porque llega después: el inventario se descuenta al
   * aceptar, pero el evento puede procesarse más tarde. Esperar a tener las dos
   * cosas para contar cualquiera dejaría el panel vacío durante el servicio.
   */
  async recordCost(
    ctx: TenantContext,
    orderId: string,
  ): Promise<{ counted: boolean; foodCost: string }> {
    const pedido = await this.cargarPedido(ctx, orderId);
    if (!pedido) return { counted: false, foodCost: '0.0000' };

    const { rows } = await ctx.client.query<{ costo: string }>(
      `SELECT COALESCE(sum(abs(quantity) * unit_cost), 0)::text AS costo
         FROM inv_movements
        WHERE order_id = $1 AND kind = 'consumption'`,
      [orderId],
    );
    const costo = rows[0]?.costo ?? '0';
    if (Number(costo) === 0) return { counted: false, foodCost: '0.0000' };

    const { rowCount } = await ctx.client.query(
      `INSERT INTO ana_counted_orders (tenant_id, order_id, fact, business_date)
       VALUES ($1,$2,'cost',$3)
       ON CONFLICT (tenant_id, order_id, fact) DO NOTHING`,
      [ctx.tenantId, orderId, pedido.business_date],
    );
    if (rowCount === 0) return { counted: false, foodCost: costo };

    await ctx.client.query(
      `INSERT INTO ana_daily_sales
         (tenant_id, business_date, brand_id, location_id, channel, food_cost)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, business_date, brand_id, location_id, channel)
       DO UPDATE SET food_cost = ana_daily_sales.food_cost + EXCLUDED.food_cost,
                     updated_at = now()`,
      [
        ctx.tenantId,
        pedido.business_date,
        pedido.brand_id,
        pedido.location_id,
        pedido.channel,
        costo,
      ],
    );

    return { counted: true, foodCost: costo };
  }

  /**
   * Cuenta una cancelación.
   *
   * Se cuenta APARTE y no se resta de `orders`: dividir ingresos entre pedidos
   * incluyendo los cancelados da un ticket promedio más bajo que el real, y
   * lleva a decisiones equivocadas sobre precios.
   */
  async recordCancellation(
    ctx: TenantContext,
    orderId: string,
  ): Promise<{ counted: boolean }> {
    const pedido = await this.cargarPedido(ctx, orderId);
    if (!pedido) return { counted: false };

    const { rowCount } = await ctx.client.query(
      `INSERT INTO ana_counted_orders (tenant_id, order_id, fact, business_date)
       VALUES ($1,$2,'cancellation',$3)
       ON CONFLICT (tenant_id, order_id, fact) DO NOTHING`,
      [ctx.tenantId, orderId, pedido.business_date],
    );
    if (rowCount === 0) return { counted: false };

    await ctx.client.query(
      `INSERT INTO ana_daily_sales
         (tenant_id, business_date, brand_id, location_id, channel, cancelled)
       VALUES ($1,$2,$3,$4,$5,1)
       ON CONFLICT (tenant_id, business_date, brand_id, location_id, channel)
       DO UPDATE SET cancelled = ana_daily_sales.cancelled + 1,
                     updated_at = now()`,
      [
        ctx.tenantId,
        pedido.business_date,
        pedido.brand_id,
        pedido.location_id,
        pedido.channel,
      ],
    );

    return { counted: true };
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  /**
   * Rentabilidad por marca y canal: la pregunta que justifica una dark kitchen.
   *
   * El margen se CALCULA aquí a partir de los sumandos guardados. Guardarlo ya
   * calculado obliga a recalcular la fila entera cada vez que llega un costo
   * tardío, y abre la puerta a que el total y sus partes discrepen.
   */
  async profitability(
    tenantId: string,
    filtros: { from: Date; to: Date; brandId?: string },
  ): Promise<BrandChannelProfitability[]> {
    if (filtros.from >= filtros.to) {
      throw new ValidationError(
        'El inicio del periodo debe ser anterior al fin.',
      );
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        brand_id: string;
        brand_name: string;
        channel: string;
        orders: string;
        cancelled: string;
        gross_revenue: string;
        discounts: string;
        tax: string;
        commission_estimated: string;
        commission_settled: string | null;
        food_cost: string;
      }>(
        `SELECT s.brand_id, b.name AS brand_name, s.channel,
                sum(s.orders)::text AS orders,
                sum(s.cancelled)::text AS cancelled,
                sum(s.gross_revenue)::text AS gross_revenue,
                sum(s.discounts)::text AS discounts,
                sum(s.tax)::text AS tax,
                sum(s.commission_estimated)::text AS commission_estimated,
                sum(s.commission_settled)::text AS commission_settled,
                sum(s.food_cost)::text AS food_cost
           FROM ana_daily_sales s
           JOIN org_brands b ON b.id = s.brand_id
          WHERE s.business_date >= $1 AND s.business_date <= $2
            AND ($3::uuid IS NULL OR s.brand_id = $3)
          GROUP BY s.brand_id, b.name, s.channel
          ORDER BY sum(s.gross_revenue) DESC`,
        [
          this.aFechaNegocio(filtros.from),
          this.aFechaNegocio(filtros.to),
          filtros.brandId ?? null,
        ],
      );

      return rows.map((r) => this.aVista(r));
    });
  }

  private aVista(r: {
    brand_id: string;
    brand_name: string;
    channel: string;
    orders: string;
    cancelled: string;
    gross_revenue: string;
    discounts: string;
    commission_estimated: string;
    commission_settled: string | null;
    food_cost: string;
  }): BrandChannelProfitability {
    const pedidos = Number(r.orders);
    // Todo el cálculo pasa por Money: es la regla innegociable del proyecto y
    // aquí importa igual, porque este número decide si se cierra una marca.
    const bruto = this.aMoney(r.gross_revenue);
    const descuentos = this.aMoney(r.discounts);
    // La comisión LIQUIDADA manda cuando existe; la estimada es una previsión
    // (RN-BIL-04) y usarla habiendo dato real inflaría el margen.
    const comision = this.aMoney(
      r.commission_settled ?? r.commission_estimated,
    );
    const costoInsumos = this.aMoney(r.food_cost);

    const neto = bruto.subtract(descuentos);
    const margen = neto.subtract(comision).subtract(costoInsumos);

    return {
      brandId: r.brand_id,
      brandName: r.brand_name,
      channel: r.channel,
      orders: pedidos,
      cancelled: Number(r.cancelled),
      grossRevenue: bruto.toDecimalString(),
      discounts: descuentos.toDecimalString(),
      netRevenue: neto.toDecimalString(),
      commission: comision.toDecimalString(),
      foodCost: costoInsumos.toDecimalString(),
      contributionMargin: margen.toDecimalString(),
      // En puntos básicos y no en porcentaje decimal, por el mismo motivo que
      // las mermas del inventario: un `0.325` arrastra coma flotante.
      marginBps:
        neto.minorUnits === 0
          ? 0
          : Math.round((margen.minorUnits / neto.minorUnits) * 10_000),
      averageTicket:
        pedidos === 0
          ? '0.0000'
          : Money.fromMinor(
              Math.round(neto.minorUnits / pedidos),
              'PEN',
            ).toDecimalString(),
    };
  }

  // -------------------------------------------------------------------------
  // Conciliación con Billing — la regla dura de la spec 16
  // -------------------------------------------------------------------------

  /**
   * Compara los ingresos de la proyección con los comprobantes emitidos.
   *
   * La spec 16 lo dice sin matices: todo número monetario del panel debe cuadrar
   * con Billing, y una divergencia es un **bug crítico**. Un panel que dice
   * S/ 12 000 y una declaración que dice S/ 11 400 no es un problema de
   * redondeo: es que alguien va a tomar una decisión con un número inventado.
   *
   * Se comparan importes Y pedidos, porque las dos formas de divergir son
   * distintas: un total que no cuadra apunta a un cálculo, y un pedido sin
   * comprobante apunta a una venta que no se declaró.
   */
  async reconcileWithBilling(
    tenantId: string,
    businessDate: Date,
  ): Promise<ReconciliationResult> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const fecha = this.aFechaNegocio(businessDate);

      const { rows: analitica } = await ctx.client.query<{ total: string }>(
        `SELECT COALESCE(sum(gross_revenue), 0)::text AS total
           FROM ana_daily_sales WHERE business_date = $1`,
        [fecha],
      );

      // Solo comprobantes ACEPTADOS: los que están en cola todavía no son una
      // declaración, y contarlos daría un cuadre falso que se rompe al primer
      // rechazo.
      const { rows: facturado } = await ctx.client.query<{ total: string }>(
        `SELECT COALESCE(sum(total), 0)::text AS total
           FROM bil_documents
          WHERE status = 'accepted' AND doc_type <> 'nota_credito'
            AND (issued_at AT TIME ZONE 'America/Lima')::date = $1`,
        [fecha],
      );

      const { rows: huerfanos } = await ctx.client.query<{
        sin_documento: string;
        sin_venta: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM ana_counted_orders c
             WHERE c.fact = 'sale' AND c.business_date = $1
               AND NOT EXISTS (
                 SELECT 1 FROM bil_documents d
                  WHERE d.order_id = c.order_id AND d.status = 'accepted'
               )) AS sin_documento,
           (SELECT count(*)::text FROM bil_documents d
             WHERE d.status = 'accepted' AND d.doc_type <> 'nota_credito'
               AND (d.issued_at AT TIME ZONE 'America/Lima')::date = $1
               AND d.order_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM ana_counted_orders c
                  WHERE c.order_id = d.order_id AND c.fact = 'sale'
               )) AS sin_venta`,
        [fecha],
      );

      const proyeccion = this.aMoney(analitica[0]?.total ?? '0');
      const comprobantes = this.aMoney(facturado[0]?.total ?? '0');
      const diferencia = proyeccion.subtract(comprobantes);

      const resultado: ReconciliationResult = {
        businessDate: fecha,
        analyticsTotal: proyeccion.toDecimalString(),
        billingTotal: comprobantes.toDecimalString(),
        difference: diferencia.toDecimalString(),
        matches: diferencia.minorUnits === 0,
        ordersWithoutDocument: Number(huerfanos[0]?.sin_documento ?? 0),
        documentsWithoutSale: Number(huerfanos[0]?.sin_venta ?? 0),
      };

      if (!resultado.matches) {
        this.logger.error(
          `CONCILIACIÓN FALLIDA ${fecha}: analítica ${resultado.analyticsTotal} vs facturado ${resultado.billingTotal} (diferencia ${resultado.difference}).`,
        );
      }

      return resultado;
    });
  }

  // -------------------------------------------------------------------------
  // Auxiliares
  // -------------------------------------------------------------------------

  private async cargarPedido(
    ctx: TenantContext,
    orderId: string,
  ): Promise<{
    brand_id: string;
    location_id: string;
    channel: string;
    business_date: string;
    total: string;
    discount_total: string;
    delivery_fee: string;
    tip: string;
    tax: string;
    commission_estimated: string;
    currency: string;
  } | null> {
    const { rows } = await ctx.client.query<{
      brand_id: string;
      location_id: string;
      channel: string;
      business_date: string;
      total: string;
      discount_total: string;
      delivery_fee: string;
      tip: string;
      tax: string;
      commission_estimated: string;
      currency: string;
    }>(
      // La fecha de NEGOCIO en la zona del local: un pedido de las 23:40 en
      // Lima es del día 7, no del 8. En UTC, el cierre de caja del viernes y
      // las ventas del viernes no cuadrarían y nadie sabría por qué.
      `SELECT o.brand_id, o.location_id, o.channel,
              (o.created_at AT TIME ZONE COALESCE(l.timezone, 'America/Lima'))::date::text
                AS business_date,
              o.total, o.discount_total, o.delivery_fee, o.tip, o.tax,
              o.commission_estimated, o.currency
         FROM ord_orders o
         JOIN org_locations l ON l.id = o.location_id
        WHERE o.id = $1`,
      [orderId],
    );
    return rows[0] ?? null;
  }

  private aMoney(valor: string): Money {
    // NUMERIC llega como cadena. Se convierte a unidades menores enteras sin
    // pasar por coma flotante en el camino intermedio.
    const [entera, decimal = ''] = valor.replace('-', '').split('.');
    const negativo = valor.startsWith('-');
    const minor =
      Number(entera) * 10_000 + Number(decimal.padEnd(4, '0').slice(0, 4));
    return Money.fromMinor(negativo ? -minor : minor, 'PEN');
  }

  private aFechaNegocio(fecha: Date): string {
    return fecha.toISOString().slice(0, 10);
  }
}
