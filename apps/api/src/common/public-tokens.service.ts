import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module.js';
import {
  withPublicToken,
  withSystem,
  withTenant,
  type TenantContext,
} from '../database/rls.js';
import { NotFoundError } from './errors.js';

/**
 * Tokens públicos de acceso acotado (ADR-0017).
 *
 * El mecanismo de primera clase que ADR-0016 pidió construir cuando apareciera
 * el quinto escape de RLS. Sirve a todo lo que tiene la misma forma: una URL
 * que llega a alguien SIN cuenta y que tiene que resolver un tenant antes de
 * enseñar nada — links de pago, tracking de pedido, y lo que venga.
 *
 * Vive en `common/` y no en un módulo de negocio a propósito: si viviera en
 * `payments`, el módulo de delivery tendría que importar internals de pagos
 * para hacer tracking, y `dependency-cruiser` lo rompería con razón.
 *
 * Lo que este servicio NO hace, y conviene tenerlo presente al usarlo:
 * **resolver no es autorizar**. Devuelve «este token es del tenant T, para el
 * propósito P, sobre el recurso R». Qué se puede ver o hacer con eso lo decide
 * el módulo dueño del recurso, por propósito, no por tener un token válido.
 */

/** Propósitos válidos. Enum cerrado: ver ADR-0017 §2. */
export const TOKEN_PURPOSES = [
  'payment_link',
  'order_tracking',
  'cart',
] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export interface ResolvedToken {
  token: string;
  tenantId: string;
  purpose: TokenPurpose;
  resourceType: string;
  resourceId: string;
  expiresAt: Date;
}

/**
 * Error de resolución. Uno solo para todos los motivos —no existe, caducó,
 * revocado, propósito equivocado— a propósito: distinguirlos convierte el
 * endpoint público en un oráculo para saber qué tokens existieron.
 */
export class PublicTokenError extends NotFoundError {
  constructor() {
    super('El enlace no es válido o ya no está disponible.');
  }
}

@Injectable()
export class PublicTokensService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Emite un token. Se llama DENTRO de la transacción del módulo dueño para
   * que el token y el recurso al que apunta aparezcan juntos o no aparezcan.
   */
  async issue(
    ctx: TenantContext,
    input: {
      purpose: TokenPurpose;
      resourceType: string;
      resourceId: string;
      expiresAt: Date;
      createdBy?: string | undefined;
    },
  ): Promise<string> {
    // 32 bytes en base64url. Este token viaja por WhatsApp, se pega en chats y
    // se reenvía: tiene que no adivinarse ni por fuerza bruta ni por vecindad
    // con otro token emitido el mismo segundo.
    const token = randomBytes(32).toString('base64url');
    await ctx.client.query(
      `INSERT INTO pub_tokens
         (token, tenant_id, purpose, resource_type, resource_id, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        token,
        ctx.tenantId,
        input.purpose,
        input.resourceType,
        input.resourceId,
        input.expiresAt,
        input.createdBy ?? null,
      ],
    );
    return token;
  }

  /**
   * Resuelve un token para un propósito CONCRETO.
   *
   * El propósito es un argumento y no un dato de salida a propósito: obliga a
   * quien llama a declarar qué esperaba. Un token de tracking presentado en la
   * ruta de pago no resuelve, y sin esa comprobación un token filtrado en un
   * sitio abriría todos los demás.
   */
  async resolve(
    token: string,
    purpose: TokenPurpose,
    now = new Date(),
  ): Promise<ResolvedToken> {
    const fila = await withPublicToken(this.pool, async ({ client }) => {
      const { rows } = await client.query<{
        token: string;
        tenant_id: string;
        purpose: TokenPurpose;
        resource_type: string;
        resource_id: string;
        expires_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT token, tenant_id, purpose, resource_type, resource_id,
                expires_at, revoked_at
           FROM pub_tokens WHERE token = $1 LIMIT 1`,
        [token],
      );
      return rows[0];
    });

    if (
      !fila ||
      fila.purpose !== purpose ||
      fila.revoked_at !== null ||
      fila.expires_at.getTime() <= now.getTime()
    ) {
      throw new PublicTokenError();
    }

    return {
      token: fila.token,
      tenantId: fila.tenant_id,
      purpose: fila.purpose,
      resourceType: fila.resource_type,
      resourceId: fila.resource_id,
      expiresAt: fila.expires_at,
    };
  }

  /**
   * Marca la primera apertura. No bloquea las siguientes (ADR-0017): un link de
   * pago que muere al abrirse pierde la venta del cliente al que le sonó el
   * teléfono. Lo que es de un solo uso es el COBRO, y eso lo garantiza la
   * máquina de estados, no el enlace.
   */
  async markUsed(tenantId: string, token: string): Promise<void> {
    await withTenant(this.pool, tenantId, async ({ client }) => {
      await client.query(
        'UPDATE pub_tokens SET used_at = COALESCE(used_at, now()) WHERE token = $1',
        [token],
      );
    });
  }

  /** Cortar hoy un enlace que se mandó al cliente equivocado. */
  async revoke(tenantId: string, token: string): Promise<void> {
    await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rowCount } = await client.query(
        'UPDATE pub_tokens SET revoked_at = now() WHERE token = $1 AND revoked_at IS NULL',
        [token],
      );
      if ((rowCount ?? 0) === 0) throw new PublicTokenError();
    });
  }

  /** Revoca todos los tokens vivos de un recurso (p. ej. al cancelar el pedido). */
  async revokeForResource(
    ctx: TenantContext,
    resourceType: string,
    resourceId: string,
  ): Promise<number> {
    const { rowCount } = await ctx.client.query(
      `UPDATE pub_tokens SET revoked_at = now()
        WHERE resource_type = $1 AND resource_id = $2 AND revoked_at IS NULL`,
      [resourceType, resourceId],
    );
    return rowCount ?? 0;
  }

  /**
   * Borra los tokens caducados hace tiempo.
   *
   * Un token caducado ya no abre nada, así que conservarlo solo acumula filas y
   * amplía lo que se lleva quien copie la tabla. Se guardan 30 días por si hay
   * que investigar un enlace concreto.
   */
  async purgeExpired(olderThanDays = 30): Promise<number> {
    return withSystem(this.pool, async ({ client }) => {
      const { rowCount } = await client.query(
        `DELETE FROM pub_tokens
          WHERE expires_at < now() - ($1 || ' days')::interval`,
        [olderThanDays],
      );
      return rowCount ?? 0;
    });
  }
}
