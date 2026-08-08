import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  Money,
  estimateCommission,
  compareCommission,
  assertValidTariff,
  type CommissionTariff,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';

/**
 * Conciliación de liquidaciones y comisiones (T5.07, RN-BIL-04).
 *
 * Hasta esta tarea, `commission_estimated` estaba en la base con `DEFAULT 0` y
 * nadie lo escribía; `commission_settled`, en la proyección de analítica,
 * esperaba a alguien que nunca llegaba. El panel de rentabilidad restaba, en la
 * práctica, una comisión de cero: **enseñaba el margen bruto llamándolo
 * margen**. Para un negocio que vende por marketplaces —donde la comisión es el
 * 25 %— eso no es un error de redondeo, es la diferencia entre creer que ganas
 * dinero y ganarlo.
 *
 * La regla que ordena el módulo es RN-BIL-04: **estimada al aceptar, liquidada
 * al conciliar, y la diferencia se reporta.** No se corrige la estimación
 * borrándola cuando llega la liquidación: se guardan las dos. La diferencia
 * sistemática entre ambas es exactamente el dato con el que se renegocia con un
 * canal, y borrarla deja al dueño sin argumento.
 */

export interface SettlementLineInput {
  /** Referencia del cargo en la pasarela. La clave del cruce. */
  providerRef: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
}

export interface SettlementInput {
  provider: string;
  externalRef: string;
  periodStart: string;
  periodEnd: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  currency?: string | undefined;
  depositedAt?: Date | undefined;
  lines: SettlementLineInput[];
}

export interface ReconciliationReport {
  settlementId: string;
  status: 'reconciled' | 'discrepant';
  /** Líneas que cuadraron con un cobro nuestro. */
  matched: number;
  /** La pasarela cobró algo que aquí NO consta. El hallazgo más serio. */
  unmatched: number;
  /** Cobros nuestros del periodo que la liquidación NO menciona. */
  missing: number;
  /** Comisiones cuya diferencia con lo estimado supera la tolerancia. */
  significantVariances: Array<{
    intentId: string;
    estimated: string;
    settled: string;
    difference: string;
    differenceBps: number;
  }>;
  /** Suma declarada por la pasarela vs suma de sus propias líneas. */
  totalsMatch: boolean;
}

@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ------------------------------------------------------------- Tarifario

  /**
   * Fija la tarifa vigente de un canal.
   *
   * **Cierra la anterior en vez de editarla.** Renegociar la comisión en marzo
   * no puede cambiar el margen de enero: si se editara la fila, el histórico
   * dejaría de ser histórico y los informes de meses cerrados cambiarían solos.
   */
  async setTariff(
    tenantId: string,
    input: {
      channel: string;
      provider?: string | undefined;
      brandId?: string | undefined;
      percentBps: number;
      fixedAmount?: string | undefined;
      minimumAmount?: string | undefined;
      actorId?: string | undefined;
    },
  ): Promise<{ id: string }> {
    assertValidTariff({
      percentBps: input.percentBps,
      fixedMinor: Money.parse(input.fixedAmount ?? '0').minorUnits,
      minimumMinor: Money.parse(input.minimumAmount ?? '0').minorUnits,
    });

    return withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.client.query(
        `UPDATE pay_channel_tariffs SET effective_to = now()
          WHERE channel = $1
            AND provider IS NOT DISTINCT FROM $2
            AND brand_id IS NOT DISTINCT FROM $3
            AND effective_to IS NULL`,
        [input.channel, input.provider ?? null, input.brandId ?? null],
      );

      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO pay_channel_tariffs
           (tenant_id, channel, provider, brand_id, percent_bps,
            fixed_amount, minimum_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          tenantId,
          input.channel,
          input.provider ?? null,
          input.brandId ?? null,
          input.percentBps,
          input.fixedAmount ?? '0',
          input.minimumAmount ?? '0',
        ],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'payment.tariff_changed',
        resourceType: 'payment_tariff',
        resourceId: rows[0]!.id,
        data: {
          channel: input.channel,
          percentBps: input.percentBps,
          fixedAmount: input.fixedAmount ?? '0',
        },
      });

      return { id: rows[0]!.id };
    });
  }

  /**
   * Resuelve la tarifa vigente por especificidad, igual que los precios:
   * (canal, proveedor, marca) gana a (canal, proveedor), que gana a (canal).
   */
  async resolveTariff(
    ctx: TenantContext,
    key: {
      channel: string;
      provider?: string | undefined;
      brandId?: string | undefined;
    },
  ): Promise<CommissionTariff | null> {
    const { rows } = await ctx.client.query<{
      percent_bps: number;
      fixed_amount: string;
      minimum_amount: string;
    }>(
      `SELECT percent_bps, fixed_amount, minimum_amount
         FROM pay_channel_tariffs
        WHERE channel = $1
          AND effective_to IS NULL
          AND (provider IS NULL OR provider = $2)
          AND (brand_id IS NULL OR brand_id = $3)
        ORDER BY brand_id NULLS LAST, provider NULLS LAST
        LIMIT 1`,
      [key.channel, key.provider ?? null, key.brandId ?? null],
    );
    const fila = rows[0];
    if (!fila) return null;

    return {
      percentBps: fila.percent_bps,
      fixedMinor: Money.parse(fila.fixed_amount).minorUnits,
      minimumMinor: Money.parse(fila.minimum_amount).minorUnits,
    };
  }

  /**
   * Estima y guarda la comisión de un cobro capturado.
   *
   * Sin tarifa configurada NO se inventa un número: se deja `NULL`. Un cero
   * escrito sería indistinguible de «este canal no cobra comisión», y el panel
   * enseñaría margen bruto con cara de margen neto — que es justo el problema
   * que esta tarea viene a arreglar.
   */
  async estimateForIntent(
    ctx: TenantContext,
    intentId: string,
  ): Promise<Money | null> {
    const { rows } = await ctx.client.query<{
      amount: string;
      currency: string;
      channel: string;
      brand_id: string;
      provider: string;
    }>(
      `SELECT i.amount, i.currency, o.channel, o.brand_id, c.provider
         FROM pay_intents i
         JOIN ord_orders o ON o.id = i.order_id
         JOIN pay_connections c ON c.id = i.connection_id
        WHERE i.id = $1`,
      [intentId],
    );
    const fila = rows[0];
    if (!fila) throw new NotFoundError('Cobro no encontrado.');

    const tarifa = await this.resolveTariff(ctx, {
      channel: fila.channel,
      provider: fila.provider,
      brandId: fila.brand_id,
    });
    if (!tarifa) return null;

    const comision = estimateCommission(
      Money.parse(fila.amount, fila.currency as 'PEN'),
      tarifa,
    );
    await ctx.client.query(
      'UPDATE pay_intents SET commission_estimated = $2 WHERE id = $1',
      [intentId, comision.toDecimalString()],
    );
    return comision;
  }

  // --------------------------------------------------------- Liquidaciones

  /**
   * Importa un informe de liquidación. Idempotente por `(proveedor, ref)`.
   *
   * Importar dos veces el mismo depósito no puede duplicar comisiones: sería
   * contarle al dueño el doble de gasto y hundir un margen que estaba bien.
   */
  async importSettlement(
    tenantId: string,
    input: SettlementInput,
    actorId?: string,
  ): Promise<{ id: string; alreadyImported: boolean }> {
    if (input.lines.length === 0) {
      throw new ValidationError(
        'Una liquidación sin líneas no se puede conciliar.',
      );
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: previas } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM pay_settlements WHERE provider = $1 AND external_ref = $2',
        [input.provider, input.externalRef],
      );
      if (previas[0]) {
        return { id: previas[0].id, alreadyImported: true };
      }

      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO pay_settlements
           (tenant_id, provider, external_ref, period_start, period_end,
            gross_amount, fee_amount, net_amount, currency, deposited_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          tenantId,
          input.provider,
          input.externalRef,
          input.periodStart,
          input.periodEnd,
          input.grossAmount,
          input.feeAmount,
          input.netAmount,
          input.currency ?? 'PEN',
          input.depositedAt ?? null,
        ],
      );
      const settlementId = rows[0]!.id;

      for (const linea of input.lines) {
        await ctx.client.query(
          `INSERT INTO pay_settlement_lines
             (tenant_id, settlement_id, provider_ref, gross_amount, fee_amount, net_amount)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, settlement_id, provider_ref) DO NOTHING`,
          [
            tenantId,
            settlementId,
            linea.providerRef,
            linea.grossAmount,
            linea.feeAmount,
            linea.netAmount,
          ],
        );
      }

      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: 'payment.settlement_imported',
        resourceType: 'payment_settlement',
        resourceId: settlementId,
        data: {
          provider: input.provider,
          lines: input.lines.length,
          net: input.netAmount,
        },
      });

      return { id: settlementId, alreadyImported: false };
    });
  }

  /**
   * Concilia una liquidación contra los cobros del sistema.
   *
   * Tres hallazgos, y los tres significan cosas distintas:
   *
   *  · **`unmatched`** — la pasarela cobró algo que aquí no consta. Es el más
   *    serio: hay dinero movido sin pedido detrás. Puede ser un cobro de otro
   *    sistema, un fraude, o una referencia mal casada; ninguna de las tres se
   *    resuelve sola.
   *  · **`missing`** — un cobro nuestro del periodo que la liquidación no
   *    menciona. Normalmente es un depósito que llegará en el siguiente corte,
   *    pero si persiste es dinero cobrado al cliente que nunca se depositó.
   *  · **Varianza de comisión** — está el cobro y cuadra el bruto, pero la
   *    comisión no es la estimada. Es lo que se lleva a renegociar.
   *
   * NO corrige nada por su cuenta. Reporta, marca, y deja la decisión a una
   * persona: una conciliación que se «arregla» sola es una conciliación que
   * esconde justo lo que había que ver.
   */
  async reconcile(
    tenantId: string,
    settlementId: string,
    toleranceBps = 100,
  ): Promise<ReconciliationReport> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: cabeceras } = await ctx.client.query<{
        id: string;
        provider: string;
        currency: string;
        gross_amount: string;
        fee_amount: string;
        net_amount: string;
        period_start: string;
        period_end: string;
      }>(
        `SELECT id, provider, currency, gross_amount, fee_amount, net_amount,
                period_start, period_end
           FROM pay_settlements WHERE id = $1`,
        [settlementId],
      );
      const liquidacion = cabeceras[0];
      if (!liquidacion) throw new NotFoundError('Liquidación no encontrada.');

      const { rows: lineas } = await ctx.client.query<{
        id: string;
        provider_ref: string;
        gross_amount: string;
        fee_amount: string;
      }>(
        `SELECT id, provider_ref, gross_amount, fee_amount
           FROM pay_settlement_lines WHERE settlement_id = $1`,
        [settlementId],
      );

      const moneda = liquidacion.currency as 'PEN';
      const varianzas: ReconciliationReport['significantVariances'] = [];
      let matched = 0;
      let unmatched = 0;
      let sumaBruta = Money.zero(moneda);
      let sumaComision = Money.zero(moneda);

      for (const linea of lineas) {
        sumaBruta = sumaBruta.add(Money.parse(linea.gross_amount, moneda));
        sumaComision = sumaComision.add(Money.parse(linea.fee_amount, moneda));

        const { rows: cobros } = await ctx.client.query<{
          id: string;
          amount: string;
          paid_amount: string | null;
          commission_estimated: string | null;
        }>(
          `SELECT id, amount, paid_amount, commission_estimated
             FROM pay_intents
            WHERE provider_ref = $1 AND status IN ('captured','refunded')`,
          [linea.provider_ref],
        );
        const cobro = cobros[0];

        if (!cobro) {
          unmatched++;
          await ctx.client.query(
            `UPDATE pay_settlement_lines
                SET status = 'unmatched',
                    detail = 'La pasarela declara un cargo que no existe en el sistema.'
              WHERE id = $1`,
            [linea.id],
          );
          continue;
        }

        const esperado = Money.parse(cobro.paid_amount ?? cobro.amount, moneda);
        const declarado = Money.parse(linea.gross_amount, moneda);
        if (esperado.minorUnits !== declarado.minorUnits) {
          await ctx.client.query(
            `UPDATE pay_settlement_lines
                SET status = 'amount_mismatch', intent_id = $2, detail = $3
              WHERE id = $1`,
            [
              linea.id,
              cobro.id,
              `Bruto declarado ${declarado.toDecimalString()} frente a ${esperado.toDecimalString()} cobrado.`,
            ],
          );
          unmatched++;
          continue;
        }

        matched++;
        const comisionReal = Money.parse(linea.fee_amount, moneda);
        await ctx.client.query(
          `UPDATE pay_settlement_lines SET status = 'matched', intent_id = $2 WHERE id = $1`,
          [linea.id, cobro.id],
        );
        await ctx.client.query(
          'UPDATE pay_intents SET commission_settled = $2 WHERE id = $1',
          [cobro.id, comisionReal.toDecimalString()],
        );

        const varianza = compareCommission(
          Money.parse(cobro.commission_estimated ?? '0', moneda),
          comisionReal,
          toleranceBps,
        );
        if (varianza.significant) {
          varianzas.push({
            intentId: cobro.id,
            estimated: varianza.estimated,
            settled: varianza.settled,
            difference: varianza.difference,
            differenceBps: varianza.differenceBps,
          });
        }
      }

      // Cobros nuestros del periodo que la liquidación no menciona.
      const { rows: faltantes } = await ctx.client.query<{ n: string }>(
        `SELECT count(*) AS n FROM pay_intents i
          WHERE i.status = 'captured'
            AND i.captured_at::date BETWEEN $1 AND $2
            AND i.commission_settled IS NULL
            AND EXISTS (
              SELECT 1 FROM pay_connections c
               WHERE c.id = i.connection_id AND c.provider = $3
            )`,
        [
          liquidacion.period_start,
          liquidacion.period_end,
          liquidacion.provider,
        ],
      );
      const missing = Number(faltantes[0]!.n);

      // ¿La pasarela cuadra consigo misma? Se guardan los tres importes de la
      // cabecera aunque neto = bruto − comisión precisamente para esto: si NO
      // cuadran, eso mismo es el hallazgo.
      const totalsMatch =
        sumaBruta.minorUnits ===
          Money.parse(liquidacion.gross_amount, moneda).minorUnits &&
        sumaComision.minorUnits ===
          Money.parse(liquidacion.fee_amount, moneda).minorUnits;

      const status =
        unmatched > 0 || missing > 0 || !totalsMatch || varianzas.length > 0
          ? 'discrepant'
          : 'reconciled';

      await ctx.client.query(
        `UPDATE pay_settlements
            SET status = $2, matched_lines = $3, unmatched_lines = $4,
                missing_lines = $5, reconciled_at = now()
          WHERE id = $1`,
        [settlementId, status, matched, unmatched, missing],
      );

      if (status === 'discrepant') {
        // Se registra como alarma, no como estadística: cada uno de estos
        // hallazgos es dinero que no cuadra.
        this.logger.error(
          `Liquidación ${settlementId} con discrepancias: ${unmatched} líneas sin cobro, ` +
            `${missing} cobros sin línea, ${varianzas.length} comisiones fuera de tolerancia` +
            `${totalsMatch ? '' : ', y los totales del informe no cuadran consigo mismos'}.`,
        );
      }

      await recordAudit(ctx, {
        actorType: 'system',
        action: 'payment.settlement_reconciled',
        resourceType: 'payment_settlement',
        resourceId: settlementId,
        data: {
          status,
          matched,
          unmatched,
          missing,
          variances: varianzas.length,
        },
      });

      return {
        settlementId,
        status,
        matched,
        unmatched,
        missing,
        significantVariances: varianzas,
        totalsMatch,
      };
    });
  }
}
