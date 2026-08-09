import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import * as argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { PG_POOL } from '../../../database/database.module.js';
import { CONFIG, type AppConfig } from '../../../config/config.js';
import {
  withTenant,
  withAuthLookup,
  type TenantContext,
} from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import { ForbiddenError } from '../../../common/errors.js';
import type { AccessTokenClaims } from '../../../common/authz.js';
import { recordAudit } from '../../audit/index.js';
import {
  grants,
  scopeCovers,
  type Permission,
  type ScopeType,
} from '../domain/permissions.js';

/**
 * Autenticación y sesiones (spec 02, docs/14).
 *
 * - Contraseñas con argon2id.
 * - Access JWT corto (15 min por defecto) + refresh rotativo.
 * - RN-IDN-02: presentar un refresh ya rotado = reuso → se revoca la FAMILIA
 *   completa y se deja traza en auditoría.
 *
 * El refresh se guarda como sha256 en BD (nunca en claro): si se filtra la
 * tabla, los tokens no son utilizables.
 */

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// Las claims son el contrato transversal definido en common/authz.ts: el
// `tid` es la ÚNICA fuente del tenant en toda la aplicación.
export type { AccessTokenClaims };

export class InvalidCredentialsError extends ForbiddenError {
  constructor() {
    // Mensaje deliberadamente genérico: no revela si el email existe.
    super('Credenciales inválidas.');
  }
}

export class TenantSuspendedError extends ForbiddenError {
  constructor() {
    super('El acceso está suspendido para esta cuenta. Contacta a soporte.');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ Hashing

  static hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  // -------------------------------------------------------------------- Login

  async login(
    email: string,
    password: string,
    meta: { ip?: string; userAgent?: string; traceId?: string } = {},
  ): Promise<AuthTokens> {
    const normalized = email.trim().toLowerCase();

    // Paso 1: resolver tenant + credenciales. Escape de SOLO LECTURA acotado a
    // idn_users (ver withAuthLookup). Nada más ocurre en este contexto.
    const found = await withAuthLookup(this.pool, async ({ db }) => {
      const rows = await db
        .select({
          id: schema.users.id,
          tenantId: schema.users.tenantId,
          passwordHash: schema.users.passwordHash,
          status: schema.users.status,
        })
        .from(schema.users)
        .where(eq(schema.users.email, normalized))
        .limit(2);
      return rows;
    });

    // Un email podría existir en más de un tenant. En el MVP eso es ambiguo:
    // se rechaza en vez de adivinar (queda como pregunta abierta en docs/22).
    if (found.length !== 1) {
      // Coste constante aproximado para no filtrar existencia por tiempo.
      await argon2.hash(password, { type: argon2.argon2id }).catch(() => '');
      throw new InvalidCredentialsError();
    }
    const user = found[0]!;

    const ok = await argon2
      .verify(user.passwordHash, password)
      .catch(() => false);
    if (!ok || user.status !== 'active') {
      throw new InvalidCredentialsError();
    }

    // Paso 2: el tenant debe estar activo (RN-TEN-03).
    await this.assertTenantActive(user.tenantId);

    // Paso 3: emitir sesión dentro del contexto del tenant.
    return withTenant(this.pool, user.tenantId, async (ctx) => {
      const tokens = await this.issueSession(
        ctx,
        user.id,
        crypto.randomUUID(),
        meta,
      );
      await recordAudit(ctx, {
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
        ...(meta.traceId !== undefined ? { traceId: meta.traceId } : {}),
        data: { ip: meta.ip ?? null },
      });
      return tokens;
    });
  }

  // ------------------------------------------------------------------ Refresh

  /**
   * Rota el refresh token. Si el token presentado ya fue rotado o revocado,
   * se interpreta como REUSO: se revoca toda la familia (RN-IDN-02).
   */
  async refresh(
    refreshToken: string,
    meta: { ip?: string; userAgent?: string; traceId?: string } = {},
  ): Promise<AuthTokens> {
    const claims = this.verifyRefreshToken(refreshToken);
    const hash = sha256(refreshToken);

    await this.assertTenantActive(claims.tid);

    // La detección de reuso NO puede lanzar dentro de la transacción: el
    // ROLLBACK desharía la propia revocación de la familia y el token robado
    // seguiría vivo. Por eso la transacción devuelve un veredicto y la
    // revocación se confirma en una transacción propia antes de responder.
    const outcome = await withTenant(this.pool, claims.tid, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.refreshHash, hash))
        .limit(1);
      const session = rows[0];

      if (!session) {
        throw new InvalidCredentialsError();
      }

      if (session.status !== 'active') {
        return {
          kind: 'reuse' as const,
          familyId: session.familyId,
          userId: session.userId,
        };
      }

      if (session.expiresAt.getTime() <= Date.now()) {
        throw new InvalidCredentialsError();
      }

      // Marcar el actual como rotado y emitir uno nuevo en la MISMA familia.
      await ctx.db
        .update(schema.sessions)
        .set({ status: 'rotated', rotatedAt: new Date() })
        .where(eq(schema.sessions.id, session.id));

      const tokens = await this.issueSession(
        ctx,
        session.userId,
        session.familyId,
        meta,
      );
      return { kind: 'ok' as const, tokens };
    });

    if (outcome.kind === 'reuse') {
      // REUSO (RN-IDN-02): revocar la familia completa y auditar, en una
      // transacción que SÍ confirma. Solo después se rechaza la petición.
      await withTenant(this.pool, claims.tid, async (ctx) => {
        await ctx.db
          .update(schema.sessions)
          .set({ status: 'revoked' })
          .where(eq(schema.sessions.familyId, outcome.familyId));

        await recordAudit(ctx, {
          actorType: 'system',
          actorId: outcome.userId,
          action: 'auth.refresh_reuse_detected',
          resourceType: 'session_family',
          resourceId: outcome.familyId,
          ...(meta.traceId !== undefined ? { traceId: meta.traceId } : {}),
          reason: 'Refresh token reutilizado: familia revocada (RN-IDN-02).',
          data: { ip: meta.ip ?? null },
        });
      });

      throw new ForbiddenError(
        'Sesión invalidada por reutilización de token. Vuelve a iniciar sesión.',
      );
    }

    return outcome.tokens;
  }

  /** Cierra la sesión: revoca la familia del refresh presentado. */
  async logout(refreshToken: string): Promise<void> {
    const claims = this.verifyRefreshToken(refreshToken);
    const hash = sha256(refreshToken);
    await withTenant(this.pool, claims.tid, async (ctx) => {
      const rows = await ctx.db
        .select({ familyId: schema.sessions.familyId })
        .from(schema.sessions)
        .where(eq(schema.sessions.refreshHash, hash))
        .limit(1);
      const family = rows[0]?.familyId;
      if (family) {
        await ctx.db
          .update(schema.sessions)
          .set({ status: 'revoked' })
          .where(eq(schema.sessions.familyId, family));
      }
    });
  }

  // ------------------------------------------------------------- Verificación

  /** Verifica un access token y devuelve sus claims. Lanza si es inválido. */
  verifyAccessToken(token: string): AccessTokenClaims {
    try {
      return jwt.verify(token, this.config.jwt.accessSecret, {
        algorithms: ['HS256'],
        issuer: 'sahana-food',
        audience: 'sahana-api',
      }) as AccessTokenClaims;
    } catch {
      throw new ForbiddenError('Token de acceso inválido o expirado.');
    }
  }

  private verifyRefreshToken(token: string): { sub: string; tid: string } {
    try {
      return jwt.verify(token, this.config.jwt.refreshSecret, {
        algorithms: ['HS256'],
        issuer: 'sahana-food',
        audience: 'sahana-refresh',
      }) as { sub: string; tid: string };
    } catch {
      throw new InvalidCredentialsError();
    }
  }

  // ----------------------------------------------------------------- Internos

  private async assertTenantActive(tenantId: string): Promise<void> {
    const { rows } = await this.pool.query<{ status: string }>(
      'SELECT status FROM ten_tenants WHERE id = $1',
      [tenantId],
    );
    const status = rows[0]?.status;
    if (!status) throw new InvalidCredentialsError();
    if (status !== 'active') throw new TenantSuspendedError();
  }

  /**
   * Emite una sesión para un usuario cuya identidad **ya se probó por otro
   * medio**. Hoy solo lo usa el POS: dispositivo emparejado + PIN correcto.
   *
   * Es el método más peligroso de este archivo y por eso lleva su propio
   * comentario: **no verifica ninguna credencial**. Quien lo llama es
   * responsable de haberlo hecho. Se expone en vez de duplicar la emisión de
   * tokens porque una segunda implementación de la firma, la rotación y el
   * registro de sesión acabaría divergiendo de esta — y la que divergiera sería
   * la que emite tokens sin revocación.
   *
   * Regla para quien añada un tercer llamador: la prueba de identidad tiene que
   * ser algo que el usuario **sabe o posee**, verificado en el servidor, en la
   * misma petición. Un id de usuario en el cuerpo no lo es.
   */
  async issueSessionForVerifiedUser(
    tenantId: string,
    userId: string,
    meta: {
      ip?: string;
      userAgent?: string;
      traceId?: string;
      /** Qué probó la identidad. Va a auditoría: sin esto, un login por PIN y
       *  uno por contraseña serían indistinguibles en el registro. */
      via: string;
    },
  ): Promise<AuthTokens> {
    await this.assertTenantActive(tenantId);

    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select({ id: schema.users.id, status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const user = rows[0];
      if (!user || user.status !== 'active') {
        throw new InvalidCredentialsError();
      }

      const tokens = await this.issueSession(
        ctx,
        userId,
        crypto.randomUUID(),
        meta,
      );
      await recordAudit(ctx, {
        actorType: 'user',
        actorId: userId,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: userId,
        ...(meta.traceId !== undefined ? { traceId: meta.traceId } : {}),
        data: { via: meta.via, ip: meta.ip ?? null },
      });
      return tokens;
    });
  }

  /** Emite access+refresh y persiste la sesión (dentro de la transacción dada). */
  private async issueSession(
    ctx: TenantContext,
    userId: string,
    familyId: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthTokens> {
    const permissions = await this.loadPermissions(ctx, userId);

    const sessionId = crypto.randomUUID();
    const accessToken = jwt.sign(
      {
        sub: userId,
        tid: ctx.tenantId,
        sid: sessionId,
        permissions: permissions.permissions,
        scopes: permissions.scopes,
      } satisfies AccessTokenClaims,
      this.config.jwt.accessSecret,
      {
        algorithm: 'HS256',
        expiresIn: this.config.jwt.accessTtl,
        issuer: 'sahana-food',
        audience: 'sahana-api',
      },
    );

    // El refresh incluye entropía propia para que dos refresh del mismo usuario
    // en el mismo segundo nunca colisionen en el índice único de hash.
    const refreshToken = jwt.sign(
      { sub: userId, tid: ctx.tenantId, jti: randomBytes(16).toString('hex') },
      this.config.jwt.refreshSecret,
      {
        algorithm: 'HS256',
        expiresIn: this.config.jwt.refreshTtl,
        issuer: 'sahana-food',
        audience: 'sahana-refresh',
      },
    );

    await ctx.db.insert(schema.sessions).values({
      id: sessionId,
      tenantId: ctx.tenantId,
      userId,
      familyId,
      refreshHash: sha256(refreshToken),
      status: 'active',
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      expiresAt: new Date(Date.now() + this.config.jwt.refreshTtl * 1000),
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.jwt.accessTtl,
    };
  }

  /** Permisos efectivos y ámbitos del usuario (unión de sus roles). */
  private async loadPermissions(
    ctx: TenantContext,
    userId: string,
  ): Promise<{
    permissions: string[];
    scopes: Array<{ scopeType: ScopeType; scopeId: string | null }>;
  }> {
    const rows = await ctx.db
      .select({
        permission: schema.rolePermissions.permission,
        scopeType: schema.userRoles.scopeType,
        scopeId: schema.userRoles.scopeId,
      })
      .from(schema.userRoles)
      .innerJoin(
        schema.rolePermissions,
        and(
          eq(schema.rolePermissions.roleId, schema.userRoles.roleId),
          eq(schema.rolePermissions.tenantId, schema.userRoles.tenantId),
        ),
      )
      .where(eq(schema.userRoles.userId, userId));

    const permissions = [...new Set(rows.map((r) => r.permission))];
    const scopeKey = new Set<string>();
    const scopes: Array<{ scopeType: ScopeType; scopeId: string | null }> = [];
    for (const r of rows) {
      const key = `${r.scopeType}:${r.scopeId ?? ''}`;
      if (!scopeKey.has(key)) {
        scopeKey.add(key);
        scopes.push({
          scopeType: r.scopeType as ScopeType,
          scopeId: r.scopeId,
        });
      }
    }
    return { permissions, scopes };
  }
}

/** Comprueba permiso + ámbito sobre unas claims ya verificadas. */
export function claimsAllow(
  claims: AccessTokenClaims,
  permission: Permission,
  requiredScope?: { scopeType: ScopeType; scopeId: string },
): boolean {
  if (!grants(claims.permissions, permission)) return false;
  return claims.scopes.some((s) => scopeCovers(s, requiredScope));
}

/** Utilidad de comparación en tiempo constante (para PIN/códigos, T3.09). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
