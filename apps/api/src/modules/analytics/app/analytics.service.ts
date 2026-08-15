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

/**
 * Zona en la que se corta el día de negocio.
 *
 * Un pedido de las 23:40 en Lima es del día 7, no del 8: en UTC, el cierre de
 * caja del viernes y las ventas del viernes no cuadrarían y nadie sabría por
 * qué. La proyección permite además la zona propia del local
 * (`COALESCE(l.timezone, …)`); esta constante es el valor por defecto y el que
 * usan las consultas que agregan varios locales.
 */
const ZONA_HORARIA_NEGOCIO = 'America/Lima';

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

/** Una línea del resumen de hoy: por marca o por canal, misma forma. */
export interface TodaySlice {
  key: string;
  label: string;
  orders: number;
  cancelled: number;
  netRevenue: string;
}

/**
 * «¿Cómo vamos hoy?» — lo que el panel enseña al abrirse (specs/ux/03).
 *
 * La comparación es contra el **mismo día de la semana pasada** y no contra
 * ayer, porque un martes no se parece a un lunes en un restaurante: comparar
 * con ayer produce alarmas los lunes y euforia los viernes, y en las dos el
 * dueño acaba ignorando el número.
 */
export interface TodaySummary {
  businessDate: string;
  comparedDate: string;
  orders: number;
  cancelled: number;
  netRevenue: string;
  averageTicket: string;
  /** Lo mismo el mismo día de la semana pasada, para tener con qué comparar. */
  comparedOrders: number;
  comparedNetRevenue: string;
  /**
   * Variación de ingresos contra la semana pasada, en puntos básicos.
   * `null` cuando no hubo venta ese día: dividir entre cero no es «+100 %», es
   * «no hay con qué comparar», y decir lo primero es mentir con un número.
   */
  changeBps: number | null;
  byBrand: TodaySlice[];
  byChannel: TodaySlice[];
  /** Pedidos vivos AHORA: los que la cocina todavía tiene entre manos. */
  activeNow: number;
}

/** Un día de la serie. Los importes van como cadena decimal, como todo aquí. */
export interface SalesPoint {
  businessDate: string;
  orders: number;
  netRevenue: string;
}

/**
 * La evolución de la venta, con su periodo anterior para comparar.
 *
 * Dos series de la MISMA longitud y alineadas por posición: el día 1 de una
 * corresponde al día 1 de la otra. Es lo que permite dibujarlas superpuestas
 * sin que quien las pinta tenga que emparejar fechas —y sin que se le ocurra
 * emparejarlas por fecha, que las desplazaría una semana entera.
 */
export interface SalesSeries {
  days: number;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  current: SalesPoint[];
  previous: SalesPoint[];
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
    filtros: {
      from?: Date;
      to?: Date;
      /**
       * Fechas de NEGOCIO ya resueltas (AAAA-MM-DD).
       *
       * Cuando quien llama piensa en días —una pantalla con dos selectores de
       * fecha— pasarlas así evita el viaje de ida y vuelta por instantes UTC,
       * que en Lima desplaza el rango un día entero.
       */
      fromBusinessDate?: string;
      toBusinessDate?: string;
      brandId?: string;
    },
  ): Promise<BrandChannelProfitability[]> {
    const desde =
      filtros.fromBusinessDate ??
      (filtros.from ? this.aFechaNegocio(filtros.from) : undefined);
    const hasta =
      filtros.toBusinessDate ??
      (filtros.to ? this.aFechaNegocio(filtros.to) : undefined);

    if (desde === undefined || hasta === undefined) {
      throw new ValidationError('Indica el periodo.');
    }
    if (desde > hasta) {
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
        [desde, hasta, filtros.brandId ?? null],
      );

      return rows.map((r) => this.aVista(r));
    });
  }

  /**
   * Resumen de hoy para la portada del panel (specs/ux/03).
   *
   * Sale de la MISMA proyección que la rentabilidad, no de `ord_orders`: un
   * `GROUP BY` sobre la tabla transaccional a las 20:30 de un viernes compite
   * con las filas que está cerrando la caja, y el dueño mirando su celular a
   * esa hora es justo el caso que hay que soportar.
   *
   * La única excepción son los **pedidos vivos ahora**, que por definición no
   * están en una proyección diaria y se cuentan con un `count(*)` filtrado por
   * estado: son decenas de filas, no un agregado del histórico.
   */
  /**
   * La venta día a día, y el mismo número de días justo antes.
   *
   * El panel tenía **el dato de un día y ninguna forma de ver la tendencia**:
   * `ana_daily_sales` guarda la serie desde F4 y no la devolvía ninguna ruta.
   * Un número suelto no dice si el negocio sube o baja, que es la única razón
   * por la que alguien abre esta pantalla dos veces.
   *
   * El periodo anterior es **contiguo y del mismo largo** —los 14 días de antes
   * de los 14 actuales—, no «el mes pasado»: comparar 14 días con 30 produce
   * una caída del 50 % que no ha ocurrido.
   *
   * Los días SIN venta salen en la serie con cero. Omitirlos haría que la línea
   * uniera el lunes con el miércoles como si el martes no hubiera existido, y
   * un martes cerrado es exactamente lo que hay que poder ver.
   */
  async salesSeries(
    tenantId: string,
    days: number,
    at: Date = new Date(),
  ): Promise<SalesSeries> {
    if (!Number.isInteger(days) || days < 2 || days > 90) {
      throw new ValidationError('El periodo va de 2 a 90 días.');
    }

    const DIA = 24 * 3_600_000;
    const fin = at.getTime();
    // `days - 1` porque hoy cuenta: 14 días son hoy y los trece anteriores.
    const dia = (desplazamiento: number): string =>
      this.aFechaNegocio(new Date(fin - desplazamiento * DIA));

    const actuales: string[] = [];
    const anteriores: string[] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      actuales.push(dia(i));
      anteriores.push(dia(i + days));
    }

    const desde = actuales[0]!;
    const hasta = actuales[actuales.length - 1]!;
    const desdeAnterior = anteriores[0]!;
    const hastaAnterior = anteriores[anteriores.length - 1]!;

    const filas = await withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        business_date: string;
        orders: string;
        gross_revenue: string;
        discounts: string;
      }>(
        `SELECT business_date::text AS business_date,
                sum(orders)::text AS orders,
                sum(gross_revenue)::text AS gross_revenue,
                sum(discounts)::text AS discounts
           FROM ana_daily_sales
          WHERE business_date BETWEEN $1::date AND $2::date
             OR business_date BETWEEN $3::date AND $4::date
          GROUP BY business_date`,
        [desdeAnterior, hastaAnterior, desde, hasta],
      );
      return rows;
    });

    const porFecha = new Map(filas.map((r) => [r.business_date, r]));
    const serie = (fechas: string[]): SalesPoint[] =>
      fechas.map((f) => {
        const r = porFecha.get(f);
        return {
          businessDate: f,
          orders: r ? Number(r.orders) : 0,
          netRevenue: r
            ? this.aMoney(r.gross_revenue)
                .subtract(this.aMoney(r.discounts))
                .toDecimalString()
            : '0.0000',
        };
      });

    return {
      days,
      from: desde,
      to: hasta,
      previousFrom: desdeAnterior,
      previousTo: hastaAnterior,
      current: serie(actuales),
      previous: serie(anteriores),
    };
  }

  async today(tenantId: string, at: Date = new Date()): Promise<TodaySummary> {
    const hoy = this.aFechaNegocio(at);
    const haceUnaSemana = this.aFechaNegocio(
      new Date(at.getTime() - 7 * 24 * 3_600_000),
    );

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        business_date: string;
        brand_id: string;
        brand_name: string;
        channel: string;
        orders: string;
        cancelled: string;
        gross_revenue: string;
        discounts: string;
      }>(
        `SELECT s.business_date::text AS business_date,
                s.brand_id, b.name AS brand_name, s.channel,
                sum(s.orders)::text AS orders,
                sum(s.cancelled)::text AS cancelled,
                sum(s.gross_revenue)::text AS gross_revenue,
                sum(s.discounts)::text AS discounts
           FROM ana_daily_sales s
           JOIN org_brands b ON b.id = s.brand_id
          WHERE s.business_date IN ($1::date, $2::date)
          GROUP BY s.business_date, s.brand_id, b.name, s.channel`,
        [hoy, haceUnaSemana],
      );

      const neto = (r: { gross_revenue: string; discounts: string }): Money =>
        this.aMoney(r.gross_revenue).subtract(this.aMoney(r.discounts));

      const deHoy = rows.filter((r) => r.business_date === hoy);
      const deLaSemanaPasada = rows.filter(
        (r) => r.business_date === haceUnaSemana,
      );

      const sumar = (
        filas: typeof rows,
        clave: (r: (typeof rows)[number]) => { key: string; label: string },
      ): TodaySlice[] => {
        const acumulado = new Map<string, TodaySlice>();
        for (const r of filas) {
          const { key, label } = clave(r);
          const previo = acumulado.get(key) ?? {
            key,
            label,
            orders: 0,
            cancelled: 0,
            netRevenue: '0.0000',
          };
          acumulado.set(key, {
            key,
            label,
            orders: previo.orders + Number(r.orders),
            cancelled: previo.cancelled + Number(r.cancelled),
            netRevenue: this.aMoney(previo.netRevenue)
              .add(neto(r))
              .toDecimalString(),
          });
        }
        // De mayor a menor venta: lo que el dueño quiere ver primero es qué
        // marca y qué canal están tirando hoy.
        return [...acumulado.values()].sort(
          (a, b) =>
            this.aMoney(b.netRevenue).minorUnits -
            this.aMoney(a.netRevenue).minorUnits,
        );
      };

      const totalDe = (
        filas: typeof rows,
      ): { pedidos: number; neto: Money } => ({
        pedidos: filas.reduce((n, r) => n + Number(r.orders), 0),
        neto: filas.reduce(
          (acc, r) => acc.add(neto(r)),
          Money.fromMinor(0, 'PEN'),
        ),
      });

      const hoyTotal = totalDe(deHoy);
      const antesTotal = totalDe(deLaSemanaPasada);
      const canceladosHoy = deHoy.reduce((n, r) => n + Number(r.cancelled), 0);

      const { rows: vivos } = await ctx.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ord_orders
          WHERE status IN ('received','needs_review','scheduled','accepted',
                           'preparing','ready','packed','dispatched')`,
      );

      return {
        businessDate: hoy,
        comparedDate: haceUnaSemana,
        orders: hoyTotal.pedidos,
        cancelled: canceladosHoy,
        netRevenue: hoyTotal.neto.toDecimalString(),
        averageTicket:
          hoyTotal.pedidos === 0
            ? '0.0000'
            : Money.fromMinor(
                Math.round(hoyTotal.neto.minorUnits / hoyTotal.pedidos),
                'PEN',
              ).toDecimalString(),
        comparedOrders: antesTotal.pedidos,
        comparedNetRevenue: antesTotal.neto.toDecimalString(),
        changeBps:
          antesTotal.neto.minorUnits === 0
            ? null
            : Math.round(
                ((hoyTotal.neto.minorUnits - antesTotal.neto.minorUnits) /
                  antesTotal.neto.minorUnits) *
                  10_000,
              ),
        byBrand: sumar(deHoy, (r) => ({
          key: r.brand_id,
          label: r.brand_name,
        })),
        byChannel: sumar(deHoy, (r) => ({ key: r.channel, label: r.channel })),
        activeNow: Number(vivos[0]?.n ?? '0'),
      };
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
    /**
     * Un INSTANTE (`Date`, del que se deduce el día en zona del local) o un día
     * de negocio ya decidido (`'2026-01-15'`).
     *
     * La distinción no es cosmética. `new Date('2026-01-15')` es medianoche
     * UTC, o sea las 19:00 del día 14 en Lima: pasar por la zona horaria una
     * fecha que ya venía sin hora la mueve un día atrás, y el panel enseñaría
     * la conciliación de la víspera con la fecha de hoy en el título.
     */
    businessDate: Date | string,
  ): Promise<ReconciliationResult> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const fecha =
        typeof businessDate === 'string'
          ? businessDate
          : this.aFechaNegocio(businessDate);

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
            AND (issued_at AT TIME ZONE $2)::date = $1`,
        [fecha, ZONA_HORARIA_NEGOCIO],
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
               AND (d.issued_at AT TIME ZONE $2)::date = $1
               AND d.order_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM ana_counted_orders c
                  WHERE c.order_id = d.order_id AND c.fact = 'sale'
               )) AS sin_venta`,
        [fecha, ZONA_HORARIA_NEGOCIO],
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

  /**
   * Fecha de negocio a partir de un instante.
   *
   * En la zona del local, NO en UTC. `toISOString().slice(0, 10)` —lo que había
   * aquí antes— devuelve el día UTC, y la proyección guarda `business_date`
   * convertido a `America/Lima` (ver `datosDelPedido`), igual que la
   * conciliación filtra los comprobantes. Entre las 19:00 y la medianoche de
   * Lima esas dos fechas NO coinciden: `reconcileWithBilling(new Date())`
   * preguntaba por el día siguiente, encontraba cero ventas y cero
   * comprobantes, y respondía `matches: true`.
   *
   * O sea: la conciliación daba «todo cuadra» justo en las horas de más venta,
   * que es cuando una divergencia importa. Lo destapó la suite corriendo a la
   * 01:37 UTC — a otra hora del día habría pasado en verde.
   */
  private aFechaNegocio(fecha: Date): string {
    // 'en-CA' formatea como YYYY-MM-DD, que es justo lo que espera la columna.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONA_HORARIA_NEGOCIO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(fecha);
  }
}
