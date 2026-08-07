import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import * as argon2 from 'argon2';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, withAuthLookup } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';

/**
 * Dispositivos POS y PIN de operador (RN-IDN-03, RN-IDN-04).
 *
 * Dos identidades distintas conviven en la misma tablet:
 *  · el DISPOSITIVO, emparejado una vez con un código de un solo uso, con
 *    token propio y revocable;
 *  · el OPERADOR, que teclea un PIN corto para cada acción sensible.
 *
 * El PIN es corto porque se teclea decenas de veces por turno. Por eso la
 * defensa no es su longitud sino el BLOQUEO POR INTENTOS, y ese bloqueo debe
 * persistir aunque la verificación falle (ver `verifyPin`).
 */

/** RN-IDN-03: 5 intentos fallidos bloquean 15 minutos. */
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;

/** Vigencia de un código de emparejamiento. */
export const PAIRING_CODE_TTL_MINUTES = 30;

const PIN_RE = /^\d{4,6}$/;

export class PinLockedError extends ForbiddenError {
  constructor(until: Date) {
    super(
      `PIN bloqueado por demasiados intentos fallidos. Reintenta después de ${until.toISOString()}.`,
      { lockedUntil: until.toISOString() },
    );
  }
}

export class InvalidPinError extends ForbiddenError {
  constructor(remainingAttempts: number) {
    super('PIN incorrecto.', { remainingAttempts });
  }
}

export class PinMustChangeError extends ForbiddenError {
  constructor() {
    super('Debes cambiar tu PIN antes de continuar.', { mustChange: true });
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Código legible de 8 caracteres, sin caracteres ambiguos (0/O, 1/I/L). */
function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet[randomInt(alphabet.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface PairedDevice {
  deviceId: string;
  deviceToken: string;
  tenantId: string;
  locationId: string | null;
  name: string;
}

@Injectable()
export class DeviceService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ------------------------------------------------------- Emparejamiento

  /**
   * Emite un código de emparejamiento de un solo uso (RN-IDN-04).
   * Devuelve el código EN CLARO una única vez: en BD solo queda su hash.
   */
  async issuePairingCode(
    tenantId: string,
    input: { locationId?: string; createdBy: string; traceId?: string },
  ): Promise<{ code: string; expiresAt: Date }> {
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MINUTES * 60_000);

    await withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.db.insert(schema.pairingCodes).values({
        tenantId,
        codeHash: sha256(code),
        locationId: input.locationId ?? null,
        createdBy: input.createdBy,
        expiresAt,
      });
      await recordAudit(ctx, {
        actorType: 'user',
        actorId: input.createdBy,
        action: 'device.pairing_code_issued',
        resourceType: 'pairing_code',
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: { locationId: input.locationId ?? null },
      });
    });

    return { code, expiresAt };
  }

  /**
   * Canjea un código y empareja el dispositivo. El código queda consumido.
   *
   * Como el login, el canje llega SIN contexto de tenant: el código es lo único
   * que se conoce. Se resuelve con el escape de solo lectura de ADR-0014 y todo
   * lo demás ocurre ya dentro del tenant.
   */
  async pairDevice(
    code: string,
    deviceName: string,
    meta: { traceId?: string } = {},
  ): Promise<PairedDevice> {
    const codeHash = sha256(code.trim().toUpperCase());

    const found = await withAuthLookup(this.pool, async ({ db }) =>
      db
        .select({
          id: schema.pairingCodes.id,
          tenantId: schema.pairingCodes.tenantId,
          locationId: schema.pairingCodes.locationId,
          expiresAt: schema.pairingCodes.expiresAt,
          usedAt: schema.pairingCodes.usedAt,
        })
        .from(schema.pairingCodes)
        .where(eq(schema.pairingCodes.codeHash, codeHash))
        .limit(1),
    );

    const pairing = found[0];
    // Mensaje único para código inexistente, usado o caducado: no revela cuál.
    if (
      !pairing ||
      pairing.usedAt !== null ||
      pairing.expiresAt <= new Date()
    ) {
      throw new ForbiddenError('Código de emparejamiento inválido o expirado.');
    }

    const deviceToken = randomBytes(32).toString('base64url');

    return withTenant(this.pool, pairing.tenantId, async (ctx) => {
      // Consumir el código de forma condicional: si otra petición se adelantó,
      // `used_at` ya no será NULL y esta actualización no afectará ninguna fila.
      // Así el "un solo uso" lo garantiza la base de datos, no el orden de las
      // llamadas.
      const consumed = await ctx.client.query(
        `UPDATE idn_pairing_codes SET used_at = now()
          WHERE id = $1 AND used_at IS NULL
          RETURNING id`,
        [pairing.id],
      );
      if (consumed.rowCount === 0) {
        throw new ForbiddenError(
          'Código de emparejamiento inválido o expirado.',
        );
      }

      const [device] = await ctx.db
        .insert(schema.devices)
        .values({
          tenantId: pairing.tenantId,
          locationId: pairing.locationId,
          name: deviceName,
          tokenHash: sha256(deviceToken),
        })
        .returning({ id: schema.devices.id });

      await ctx.db
        .update(schema.pairingCodes)
        .set({ deviceId: device!.id })
        .where(eq(schema.pairingCodes.id, pairing.id));

      await recordAudit(ctx, {
        actorType: 'system',
        action: 'device.paired',
        resourceType: 'device',
        resourceId: device!.id,
        ...(meta.traceId !== undefined ? { traceId: meta.traceId } : {}),
        data: { name: deviceName, locationId: pairing.locationId },
      });

      return {
        deviceId: device!.id,
        deviceToken,
        tenantId: pairing.tenantId,
        locationId: pairing.locationId,
        name: deviceName,
      };
    });
  }

  /** Autentica un dispositivo por su token. Devuelve su tenant y local. */
  async authenticateDevice(deviceToken: string): Promise<{
    deviceId: string;
    tenantId: string;
    locationId: string | null;
  }> {
    const tokenHash = sha256(deviceToken);
    const found = await withAuthLookup(this.pool, async ({ db }) =>
      db
        .select({
          id: schema.devices.id,
          tenantId: schema.devices.tenantId,
          locationId: schema.devices.locationId,
          status: schema.devices.status,
        })
        .from(schema.devices)
        .where(eq(schema.devices.tokenHash, tokenHash))
        .limit(1),
    );

    const device = found[0];
    if (!device || device.status !== 'active') {
      throw new ForbiddenError('Dispositivo no autorizado o revocado.');
    }

    // Marca de actividad; no bloquea la respuesta si falla.
    await withTenant(this.pool, device.tenantId, async (ctx) => {
      await ctx.db
        .update(schema.devices)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.devices.id, device.id));
    });

    return {
      deviceId: device.id,
      tenantId: device.tenantId,
      locationId: device.locationId,
    };
  }

  /** Revoca un dispositivo (tablet perdida o robada). Efecto inmediato. */
  async revokeDevice(
    tenantId: string,
    deviceId: string,
    revokedBy: string,
    reason: string,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      const result = await ctx.db
        .update(schema.devices)
        .set({ status: 'revoked', revokedAt: new Date(), revokedBy })
        .where(eq(schema.devices.id, deviceId))
        .returning({ id: schema.devices.id });

      if (result.length === 0)
        throw new NotFoundError('Dispositivo no encontrado.');

      await recordAudit(ctx, {
        actorType: 'user',
        actorId: revokedBy,
        action: 'device.revoked',
        resourceType: 'device',
        resourceId: deviceId,
        reason,
      });
    });
  }

  async listDevices(tenantId: string): Promise<unknown[]> {
    return withTenant(this.pool, tenantId, async (ctx) =>
      ctx.db
        .select({
          id: schema.devices.id,
          name: schema.devices.name,
          locationId: schema.devices.locationId,
          status: schema.devices.status,
          pairedAt: schema.devices.pairedAt,
          lastSeenAt: schema.devices.lastSeenAt,
        })
        .from(schema.devices),
    );
  }

  // ---------------------------------------------------------------- PIN

  /** Establece o cambia el PIN de un operador (RN-IDN-03). */
  async setPin(
    tenantId: string,
    userId: string,
    pin: string,
    options: { mustChange?: boolean; actorId?: string } = {},
  ): Promise<void> {
    if (!PIN_RE.test(pin)) {
      throw new ValidationError('El PIN debe tener entre 4 y 6 dígitos.');
    }
    // Rechaza los PIN triviales más comunes: son la mitad de los intentos reales
    // de un atacante con 5 oportunidades.
    if (
      /^(\d)\1+$/.test(pin) ||
      '0123456789'.includes(pin) ||
      '9876543210'.includes(pin)
    ) {
      throw new ValidationError(
        'El PIN es demasiado predecible (dígitos repetidos o consecutivos).',
      );
    }

    const pinHash = await argon2.hash(pin, { type: argon2.argon2id });

    await withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.client.query(
        `INSERT INTO idn_user_pins
           (tenant_id, user_id, pin_hash, must_change, failed_attempts, locked_until, updated_at)
         VALUES ($1, $2, $3, $4, 0, NULL, now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE
           SET pin_hash = EXCLUDED.pin_hash,
               must_change = EXCLUDED.must_change,
               failed_attempts = 0,
               locked_until = NULL,
               updated_at = now()`,
        [tenantId, userId, pinHash, options.mustChange ?? false],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        actorId: options.actorId ?? userId,
        action: 'pin.changed',
        resourceType: 'user',
        resourceId: userId,
      });
    });
  }

  /**
   * Verifica el PIN de un operador (RN-IDN-03).
   *
   * CUIDADO DELIBERADO CON LA TRANSACCIÓN: el contador de intentos fallidos se
   * incrementa en una transacción PROPIA que CONFIRMA, y solo después se lanza
   * el error. Si se incrementara en la misma transacción que lanza, el rollback
   * lo desharía y la fuerza bruta quedaría abierta pese a existir el contador.
   * Es el mismo fallo que ya se corrigió en la rotación de refresh tokens.
   */
  async verifyPin(
    tenantId: string,
    userId: string,
    pin: string,
    meta: { traceId?: string } = {},
  ): Promise<{ ok: true; mustChange: boolean }> {
    const state = await withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.userPins)
        .where(
          and(
            eq(schema.userPins.tenantId, tenantId),
            eq(schema.userPins.userId, userId),
          ),
        )
        .limit(1);
      return rows[0];
    });

    if (!state) {
      throw new NotFoundError('El operador no tiene PIN configurado.');
    }

    // Bloqueo vigente: no se gasta CPU en verificar ni se altera el contador.
    if (state.lockedUntil && state.lockedUntil > new Date()) {
      throw new PinLockedError(state.lockedUntil);
    }

    const valid = await argon2.verify(state.pinHash, pin).catch(() => false);

    if (!valid) {
      // Transacción propia que SÍ confirma el incremento del contador.
      const after = await withTenant(this.pool, tenantId, async (ctx) => {
        const { rows } = await ctx.client.query<{
          failed_attempts: number;
          locked_until: Date | null;
        }>(
          `UPDATE idn_user_pins
              SET failed_attempts = failed_attempts + 1,
                  locked_until = CASE
                    WHEN failed_attempts + 1 >= $3
                    THEN now() + ($4 || ' minutes')::interval
                    ELSE locked_until
                  END,
                  updated_at = now()
            WHERE tenant_id = $1 AND user_id = $2
            RETURNING failed_attempts, locked_until`,
          [tenantId, userId, MAX_PIN_ATTEMPTS, String(PIN_LOCK_MINUTES)],
        );
        const result = rows[0]!;

        if (result.locked_until) {
          await recordAudit(ctx, {
            actorType: 'system',
            actorId: userId,
            action: 'pin.locked',
            resourceType: 'user',
            resourceId: userId,
            ...(meta.traceId !== undefined ? { traceId: meta.traceId } : {}),
            reason: `PIN bloqueado tras ${result.failed_attempts} intentos fallidos.`,
          });
        }
        return result;
      });

      if (after.locked_until) {
        throw new PinLockedError(after.locked_until);
      }
      throw new InvalidPinError(
        Math.max(0, MAX_PIN_ATTEMPTS - after.failed_attempts),
      );
    }

    // Acierto: se limpia el contador.
    await withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.db
        .update(schema.userPins)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.userPins.tenantId, tenantId),
            eq(schema.userPins.userId, userId),
          ),
        );
    });

    return { ok: true, mustChange: state.mustChange };
  }

  /**
   * Verifica el PIN para una acción sensible (descuento sobre umbral,
   * anulación, apertura de caja) y exige que no esté pendiente de cambio
   * (RN-IDN-03: cambio obligatorio al primer uso). Lo usarán los módulos de F4.
   */
  async verifyPinForSensitiveAction(
    tenantId: string,
    userId: string,
    pin: string,
  ): Promise<void> {
    const result = await this.verifyPin(tenantId, userId, pin);
    if (result.mustChange) {
      throw new PinMustChangeError();
    }
  }
}
