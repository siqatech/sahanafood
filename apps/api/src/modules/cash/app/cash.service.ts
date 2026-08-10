import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Pool } from 'pg';
import { Money } from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { enqueueEvent } from '../../../events/outbox.js';
import { DeviceService } from '../../identity/index.js';

/**
 * Caja: sesiones, movimientos y arqueo (spec 06, T4.17/T4.18).
 *
 * Es la parte del sistema donde un fallo no se descubre en un log sino en una
 * caja que no cuadra al final del turno, con un cajero delante que no sabe qué
 * pasó. De ahí las tres decisiones que gobiernan el módulo:
 *
 * · **La sesión es el contenedor de responsabilidad.** Un turno tiene un
 *   responsable, un fondo y un conteo final. Sin sesión no se vende
 *   (RN-POS-01): un cobro sin sesión es dinero que entra sin que nadie
 *   responda por él, y reaparece como descuadre en el turno de otro.
 * · **Los movimientos no se editan.** UPDATE y DELETE están revocados en la
 *   base. Un registro corregible no sirve para arquear.
 * · **El esperado se CALCULA, no se guarda mientras la sesión vive.** Guardar
 *   un total acumulado abre la puerta a que el total y sus partes discrepen,
 *   que es justo el error que un arqueo debe detectar.
 */

export type MovementKind = 'sale' | 'refund' | 'cash_in' | 'cash_out' | 'tip';
export type PaymentMethod = 'cash' | 'card' | 'wallet' | 'transfer' | 'other';

/** Signo de cada tipo sobre el efectivo en gaveta. */
const CASH_SIGN: Record<MovementKind, 1 | -1> = {
  sale: 1,
  tip: 1,
  cash_in: 1,
  refund: -1,
  cash_out: -1,
};

export class NoOpenCashSessionError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/no-open-cash-session';
  readonly title = 'No hay caja abierta';
  readonly code = 'NO_OPEN_CASH_SESSION';
}

export class CashSessionAlreadyOpenError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/cash-session-already-open';
  readonly title = 'Ya hay una caja abierta';
  readonly code = 'CASH_SESSION_ALREADY_OPEN';
}

export class CashSessionClosedError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/cash-session-closed';
  readonly title = 'La sesión de caja ya está cerrada';
  readonly code = 'CASH_SESSION_CLOSED';
}

/** Cerrar con descuadre exige motivo y aprobación con PIN (RN-POS-02). */
export class CashDifferenceRequiresApprovalError extends DomainError {
  readonly status = 422;
  readonly type =
    'https://errors.sahana.food/cash-difference-requires-approval';
  readonly title = 'La diferencia de caja exige motivo y PIN de supervisor';
  readonly code = 'CASH_DIFFERENCE_REQUIRES_APPROVAL';
}

export interface CashSessionView {
  id: string;
  locationId: string;
  deviceId: string | null;
  openedBy: string;
  closedBy: string | null;
  status: 'open' | 'closing' | 'closed';
  openingFloat: ReturnType<Money['toJSON']>;
  declaredCash: ReturnType<Money['toJSON']> | null;
  expectedCash: ReturnType<Money['toJSON']> | null;
  difference: ReturnType<Money['toJSON']> | null;
  differenceReason: string | null;
  approvedBy: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface CashSummary {
  sessionId: string;
  openingFloat: ReturnType<Money['toJSON']>;
  /** Fondo + entradas − salidas EN EFECTIVO: lo que debería haber en gaveta. */
  expectedCash: ReturnType<Money['toJSON']>;
  /** Desglose por tipo, en efectivo. */
  byKind: Record<MovementKind, ReturnType<Money['toJSON']>>;
  /** Totales por medio de pago, incluidos los que no tocan la gaveta. */
  byMethod: Record<string, ReturnType<Money['toJSON']>>;
  movements: number;
}

@Injectable()
export class CashService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly devices: DeviceService,
  ) {}

  // ------------------------------------------------------------- Apertura

  async open(
    tenantId: string,
    input: {
      locationId: string;
      deviceId?: string | undefined;
      openedBy: string;
      openingFloatMinor?: number | undefined;
      notes?: string | undefined;
      traceId?: string | undefined;
    },
  ): Promise<CashSessionView> {
    const fondo = Money.fromMinor(input.openingFloatMinor ?? 0);

    return withTenant(this.pool, tenantId, async (ctx) => {
      try {
        const [fila] = await ctx.db
          .insert(schema.cashSessions)
          .values({
            tenantId,
            locationId: input.locationId,
            deviceId: input.deviceId ?? null,
            openedBy: input.openedBy,
            openingFloat: fondo.toDecimalString(),
            notes: input.notes ?? null,
          })
          .returning();

        await recordAudit(ctx, {
          actorType: 'user',
          actorId: input.openedBy,
          action: 'cash.session_opened',
          resourceType: 'cash_session',
          resourceId: fila!.id,
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          data: {
            locationId: input.locationId,
            openingFloat: fondo.toJSON(),
          },
        });

        return this.toView(fila!);
      } catch (error) {
        // El índice único es lo que impide de verdad dos cajas abiertas en la
        // misma terminal: con dos sesiones vivas es imposible saber a cuál
        // pertenece un cobro, y el descuadre aparece al cerrar la primera.
        if (isUniqueViolation(error)) {
          throw new CashSessionAlreadyOpenError(
            'Esta caja ya tiene una sesión abierta. Ciérrala antes de abrir otra.',
          );
        }
        throw error;
      }
    });
  }

  /**
   * Sesión abierta de una terminal (o del responsable si no hay terminal).
   * Devuelve `undefined` en vez de lanzar: quien pregunta suele querer saber
   * si puede vender, no manejar una excepción.
   */
  async findOpenSession(
    tenantId: string,
    where: {
      deviceId?: string | undefined;
      locationId?: string | undefined;
      openedBy?: string | undefined;
    },
    existingCtx?: TenantContext,
  ): Promise<CashSessionView | undefined> {
    const buscar = async (
      ctx: TenantContext,
    ): Promise<CashSessionView | undefined> => {
      const condiciones = [ne(schema.cashSessions.status, 'closed')];
      if (where.deviceId) {
        condiciones.push(eq(schema.cashSessions.deviceId, where.deviceId));
      }
      if (where.locationId) {
        condiciones.push(eq(schema.cashSessions.locationId, where.locationId));
      }
      if (where.openedBy) {
        condiciones.push(eq(schema.cashSessions.openedBy, where.openedBy));
      }
      const filas = await ctx.db
        .select()
        .from(schema.cashSessions)
        .where(and(...condiciones))
        .orderBy(desc(schema.cashSessions.openedAt))
        .limit(1);
      return filas[0] ? this.toView(filas[0]) : undefined;
    };
    return existingCtx
      ? buscar(existingCtx)
      : withTenant(this.pool, tenantId, buscar);
  }

  /**
   * RN-POS-01: no se vende sin caja abierta. Se llama desde el flujo de cobro
   * del POS antes de registrar nada.
   */
  async assertOpenSession(
    tenantId: string,
    where: {
      deviceId?: string | undefined;
      locationId?: string | undefined;
      openedBy?: string | undefined;
    },
  ): Promise<CashSessionView> {
    const sesion = await this.findOpenSession(tenantId, where);
    if (!sesion) {
      throw new NoOpenCashSessionError(
        'No hay una sesión de caja abierta: abre caja antes de cobrar.',
      );
    }
    return sesion;
  }

  // ---------------------------------------------------------- Movimientos

  async addMovement(
    tenantId: string,
    sessionId: string,
    input: {
      kind: MovementKind;
      amountMinor: number;
      method?: PaymentMethod | undefined;
      orderId?: string | undefined;
      actorId?: string | undefined;
      reason?: string | undefined;
      traceId?: string | undefined;
    },
  ): Promise<{ id: string; amount: ReturnType<Money['toJSON']> }> {
    if (input.amountMinor <= 0) {
      // El signo lo da el tipo. Un importe negativo con un tipo de salida da
      // un doble negativo que nadie ve hasta el arqueo.
      throw new ValidationError(
        'El importe del movimiento debe ser positivo; el signo lo determina el tipo.',
      );
    }
    // Sacar dinero sin decir por qué es lo que hace imposible auditar una caja.
    if (
      (input.kind === 'cash_out' || input.kind === 'refund') &&
      !input.reason?.trim()
    ) {
      throw new ValidationError(
        'Una salida de efectivo o una devolución exige motivo.',
      );
    }

    const importe = Money.fromMinor(input.amountMinor);

    return withTenant(this.pool, tenantId, async (ctx) => {
      const sesion = await this.loadSession(ctx, sessionId);
      if (sesion.status === 'closed') {
        throw new CashSessionClosedError(
          'La sesión ya está cerrada: un movimiento posterior descuadraría un arqueo ya firmado.',
        );
      }

      try {
        const [fila] = await ctx.db
          .insert(schema.cashMovements)
          .values({
            tenantId,
            sessionId,
            kind: input.kind,
            method: input.method ?? 'cash',
            amount: importe.toDecimalString(),
            orderId: input.orderId ?? null,
            actorId: input.actorId ?? null,
            reason: input.reason ?? null,
            traceId: input.traceId ?? null,
          })
          .returning({ id: schema.cashMovements.id });

        // Las salidas de efectivo van a auditoría siempre: es el movimiento
        // que un arqueo tiene que poder explicar.
        if (input.kind === 'cash_out' || input.kind === 'refund') {
          await recordAudit(ctx, {
            actorType: 'user',
            ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
            action: `cash.${input.kind}`,
            resourceType: 'cash_session',
            resourceId: sessionId,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
            data: { amount: importe.toJSON(), method: input.method ?? 'cash' },
          });
        }

        return { id: fila!.id, amount: importe.toJSON() };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ValidationError(
            'Ese pedido ya se cobró en esta caja: registrarlo dos veces inventaría ingresos.',
            { orderId: input.orderId },
          );
        }
        throw error;
      }
    });
  }

  /**
   * Resumen del turno. El esperado se calcula sumando movimientos, nunca se
   * lee de un acumulado: si el total y sus partes pudieran discrepar, el
   * arqueo dejaría de detectar precisamente lo que existe para detectar.
   */
  async summary(
    tenantId: string,
    sessionId: string,
    existingCtx?: TenantContext,
  ): Promise<CashSummary> {
    const calcular = async (ctx: TenantContext): Promise<CashSummary> => {
      const sesion = await this.loadSession(ctx, sessionId);
      const fondo = Money.parse(sesion.openingFloat);

      const movimientos = await ctx.db
        .select()
        .from(schema.cashMovements)
        .where(eq(schema.cashMovements.sessionId, sessionId));

      const porTipo: Record<MovementKind, Money> = {
        sale: Money.zero(),
        refund: Money.zero(),
        cash_in: Money.zero(),
        cash_out: Money.zero(),
        tip: Money.zero(),
      };
      const porMetodo = new Map<string, Money>();
      let efectivo = fondo;

      for (const m of movimientos) {
        const importe = Money.parse(m.amount);
        const tipo = m.kind as MovementKind;

        porMetodo.set(
          m.method,
          (porMetodo.get(m.method) ?? Money.zero()).add(importe),
        );

        // Solo el efectivo mueve la gaveta. Una venta con tarjeta se registra
        // para cuadrar el turno, pero contarla como efectivo produciría un
        // faltante del tamaño exacto de lo cobrado con tarjeta.
        if (m.method !== 'cash') continue;

        porTipo[tipo] = porTipo[tipo].add(importe);
        efectivo =
          CASH_SIGN[tipo] === 1
            ? efectivo.add(importe)
            : efectivo.subtract(importe);
      }

      return {
        sessionId,
        openingFloat: fondo.toJSON(),
        expectedCash: efectivo.toJSON(),
        byKind: {
          sale: porTipo.sale.toJSON(),
          refund: porTipo.refund.toJSON(),
          cash_in: porTipo.cash_in.toJSON(),
          cash_out: porTipo.cash_out.toJSON(),
          tip: porTipo.tip.toJSON(),
        },
        byMethod: Object.fromEntries(
          [...porMetodo.entries()].map(([k, v]) => [k, v.toJSON()]),
        ),
        movements: movimientos.length,
      };
    };

    return existingCtx
      ? calcular(existingCtx)
      : withTenant(this.pool, tenantId, calcular);
  }

  // ------------------------------------------------------ Arqueo y cierre

  /**
   * Cierra el turno comparando lo DECLARADO con lo ESPERADO (RN-POS-02).
   *
   * Si hay diferencia, exige motivo y PIN de supervisor. No es burocracia: un
   * cierre con descuadre sin firmar es la forma más limpia de que el dinero
   * desaparezca sin que quede nadie señalado, y a las 23:00 con ganas de irse
   * a casa es exactamente la regla que se salta.
   */
  async closeSession(
    tenantId: string,
    sessionId: string,
    input: {
      declaredCashMinor: number;
      closedBy: string;
      differenceReason?: string | undefined;
      /** Supervisor que autoriza la diferencia. */
      supervisorId?: string | undefined;
      supervisorPin?: string | undefined;
      traceId?: string | undefined;
    },
  ): Promise<CashSessionView> {
    if (input.declaredCashMinor < 0) {
      throw new ValidationError('El efectivo contado no puede ser negativo.');
    }

    // El resumen se calcula ANTES de pedir el PIN: si no hay diferencia, no
    // hay que molestar a nadie.
    const resumen = await this.summary(tenantId, sessionId);
    const declarado = Money.fromMinor(input.declaredCashMinor);
    const esperado = Money.fromMinor(resumen.expectedCash.minorUnits);
    const diferencia = declarado.subtract(esperado);
    const hayDiferencia = diferencia.minorUnits !== 0;

    if (hayDiferencia) {
      if (!input.differenceReason?.trim()) {
        throw new CashDifferenceRequiresApprovalError(
          `La caja no cuadra por ${diferencia.toDecimalString()}: hace falta un motivo.`,
          {
            expected: esperado.toJSON(),
            declared: declarado.toJSON(),
            difference: diferencia.toJSON(),
          },
        );
      }
      if (!input.supervisorId || !input.supervisorPin) {
        throw new CashDifferenceRequiresApprovalError(
          `La caja no cuadra por ${diferencia.toDecimalString()}: hace falta el PIN de un supervisor.`,
          {
            expected: esperado.toJSON(),
            declared: declarado.toJSON(),
            difference: diferencia.toJSON(),
          },
        );
      }
      // Dos personas de verdad: distinta de quien cierra, con su PIN —que va
      // con bloqueo por intentos (RN-IDN-03)— y con el permiso que el cajero NO
      // tiene. Antes bastaba un PIN cualquiera, así que el cajero podía poner
      // el suyo y firmar su propio descuadre.
      await this.devices.authorizeApproval({
        tenantId,
        approverId: input.supervisorId,
        pin: input.supervisorPin,
        requestedBy: input.closedBy,
        permission: 'cash.approve_difference',
      });
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      // FOR UPDATE: dos cierres simultáneos de la misma caja se serializan.
      const { rows } = await ctx.client.query<{ status: string }>(
        'SELECT status FROM cash_sessions WHERE id = $1 FOR UPDATE',
        [sessionId],
      );
      if (!rows[0]) throw new NotFoundError('Sesión de caja no encontrada.');
      if (rows[0].status === 'closed') {
        throw new CashSessionClosedError('Esta sesión ya se cerró.');
      }

      const [fila] = await ctx.db
        .update(schema.cashSessions)
        .set({
          status: 'closed',
          closedBy: input.closedBy,
          declaredCash: declarado.toDecimalString(),
          // Se congela el esperado: un movimiento tardío no puede reescribir
          // un arqueo ya firmado.
          expectedCash: esperado.toDecimalString(),
          difference: diferencia.toDecimalString(),
          differenceReason: input.differenceReason ?? null,
          approvedBy: hayDiferencia ? (input.supervisorId ?? null) : null,
          closedAt: new Date(),
        })
        .where(eq(schema.cashSessions.id, sessionId))
        .returning();

      await recordAudit(ctx, {
        actorType: 'user',
        actorId: input.closedBy,
        action: hayDiferencia
          ? 'cash.session_closed_with_difference'
          : 'cash.session_closed',
        resourceType: 'cash_session',
        resourceId: sessionId,
        ...(input.differenceReason !== undefined
          ? { reason: input.differenceReason }
          : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: {
          expected: esperado.toJSON(),
          declared: declarado.toJSON(),
          difference: diferencia.toJSON(),
          approvedBy: input.supervisorId ?? null,
          movements: resumen.movements,
        },
      });

      await enqueueEvent(ctx, {
        aggregateType: 'cash_session',
        aggregateId: sessionId,
        eventType: 'cash.session_closed',
        payload: {
          sessionId,
          difference: diferencia.toJSON(),
          movements: resumen.movements,
        },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      return this.toView(fila!);
    });
  }

  async getSession(
    tenantId: string,
    sessionId: string,
  ): Promise<CashSessionView> {
    return withTenant(this.pool, tenantId, async (ctx) =>
      this.toView(await this.loadSession(ctx, sessionId)),
    );
  }

  async listSessions(
    tenantId: string,
    query: { locationId?: string; limit?: number } = {},
  ): Promise<CashSessionView[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const base = ctx.db.select().from(schema.cashSessions);
      const filtrada = query.locationId
        ? base.where(eq(schema.cashSessions.locationId, query.locationId))
        : base;
      const filas = await filtrada
        .orderBy(desc(schema.cashSessions.openedAt))
        .limit(Math.min(query.limit ?? 50, 200));
      return filas.map((f) => this.toView(f));
    });
  }

  // ------------------------------------------------------------- Internos

  private async loadSession(
    ctx: TenantContext,
    sessionId: string,
  ): Promise<typeof schema.cashSessions.$inferSelect> {
    const filas = await ctx.db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, sessionId))
      .limit(1);
    if (!filas[0]) throw new NotFoundError('Sesión de caja no encontrada.');
    return filas[0];
  }

  private toView(
    fila: typeof schema.cashSessions.$inferSelect,
  ): CashSessionView {
    return {
      id: fila.id,
      locationId: fila.locationId,
      deviceId: fila.deviceId,
      openedBy: fila.openedBy,
      closedBy: fila.closedBy,
      status: fila.status as 'open' | 'closing' | 'closed',
      openingFloat: Money.parse(fila.openingFloat).toJSON(),
      declaredCash: fila.declaredCash
        ? Money.parse(fila.declaredCash).toJSON()
        : null,
      expectedCash: fila.expectedCash
        ? Money.parse(fila.expectedCash).toJSON()
        : null,
      difference: fila.difference
        ? Money.parse(fila.difference).toJSON()
        : null,
      differenceReason: fila.differenceReason,
      approvedBy: fila.approvedBy,
      openedAt: fila.openedAt.toISOString(),
      closedAt: fila.closedAt?.toISOString() ?? null,
    };
  }
}

/**
 * ¿Es una violación de índice único de Postgres?
 *
 * Se recorre la cadena de `cause`. Desde Drizzle 0.45 el error del driver ya no
 * llega pelado: viene envuelto en un `DrizzleQueryError` cuyo `message` es
 * «Failed query: …» y que guarda el error de `pg` —con su `code`— en `cause`.
 * Mirando solo el nivel de arriba, el `23505` deja de reconocerse y en vez de
 * «esta terminal ya tiene una sesión abierta» al cajero le sale un volcado de
 * SQL con los parámetros dentro. Recorrer la cadena funciona con las dos
 * formas, así que no hay que volver aquí en la próxima subida de versión.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let actual = error, saltos = 0; actual != null && saltos < 5; saltos++) {
    if (typeof actual !== 'object') return false;
    if ((actual as { code?: string }).code === '23505') return true;
    actual = (actual as { cause?: unknown }).cause;
  }
  return false;
}
