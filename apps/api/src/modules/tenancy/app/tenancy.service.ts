import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import { LimitExceededError, NotFoundError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { seedSystemRoles, createOwnerUser } from '../../identity/index.js';

/**
 * Módulo Tenancy (spec 01): tenants, planes, límites y feature flags.
 *
 * RN-TEN-01 Crear tenant provisiona: tenant + configuración Perú por defecto +
 *           roles del sistema + usuario propietario + auditoría de alta.
 * RN-TEN-02 Límites de plan verificados al crear recursos (429 LIMIT_EXCEEDED).
 * RN-TEN-03 Suspensión bloquea login y API, NO borra datos.
 */

export interface PlanLimits {
  brands?: number;
  locations?: number;
  users?: number;
}

export interface TenantView {
  id: string;
  name: string;
  status: string;
  country: string;
  currency: string;
  timezone: string;
  settings: Record<string, unknown>;
}

export interface LimitsView {
  plan: string;
  limits: PlanLimits;
  usage: Record<string, number>;
}

/** Recursos con límite por plan y cómo se cuentan. */
const COUNTABLE = {
  users: 'idn_users',
} as const;
export type CountableResource = keyof typeof COUNTABLE;

@Injectable()
export class TenancyService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Datos del tenant propio (el id viene del token, nunca del payload). */
  async getTenant(tenantId: string): Promise<TenantView> {
    const { rows } = await this.pool.query<TenantView>(
      `SELECT id, name, status, country, currency, timezone, settings
         FROM ten_tenants WHERE id = $1`,
      [tenantId],
    );
    const tenant = rows[0];
    if (!tenant) throw new NotFoundError('Tenant no encontrado.');
    return tenant;
  }

  /** Límites del plan y consumo actual (RN-TEN-02). */
  async getLimits(tenantId: string): Promise<LimitsView> {
    const { rows } = await this.pool.query<{
      code: string;
      limits: PlanLimits;
    }>(
      `SELECT p.code, p.limits
         FROM ten_tenants t JOIN ten_plans p ON p.id = t.plan_id
        WHERE t.id = $1`,
      [tenantId],
    );
    const plan = rows[0];
    if (!plan) throw new NotFoundError('Plan del tenant no encontrado.');

    const usage: Record<string, number> = {};
    for (const resource of Object.keys(COUNTABLE) as CountableResource[]) {
      usage[resource] = await this.countResource(tenantId, resource);
    }
    return { plan: plan.code, limits: plan.limits, usage };
  }

  /**
   * Verifica un límite ANTES de crear un recurso. Lanza 429 LIMIT_EXCEEDED con
   * mensaje de upgrade (RN-TEN-02).
   *
   * El conteo se hace con `FOR UPDATE` sobre la fila del tenant, de modo que
   * dos peticiones simultáneas al borde del límite se serializan y solo una
   * pasa (prueba de límites concurrentes de la spec 01).
   */
  async assertWithinLimit(
    ctx: TenantContext,
    resource: CountableResource,
  ): Promise<void> {
    // Cerrojo por tenant: serializa las verificaciones concurrentes.
    await ctx.client.query(
      'SELECT id FROM ten_tenants WHERE id = $1 FOR UPDATE',
      [ctx.tenantId],
    );

    const { rows: planRows } = await ctx.client.query<{ limits: PlanLimits }>(
      `SELECT p.limits FROM ten_tenants t JOIN ten_plans p ON p.id = t.plan_id
        WHERE t.id = $1`,
      [ctx.tenantId],
    );
    const max = planRows[0]?.limits?.[resource];
    if (max === undefined) return; // recurso sin límite en este plan

    const { rows: countRows } = await ctx.client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ${COUNTABLE[resource]}`,
    );
    const current = Number(countRows[0]?.c ?? 0);

    if (current >= max) {
      throw new LimitExceededError(
        `Alcanzaste el límite de tu plan para ${resource} (${max}). ` +
          'Actualiza tu plan para seguir creciendo.',
        { resource, limit: max, current },
      );
    }
  }

  private async countResource(
    tenantId: string,
    resource: CountableResource,
  ): Promise<number> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM ${COUNTABLE[resource]}`,
      );
      return Number(rows[0]?.c ?? 0);
    });
  }

  /**
   * Provisión completa de un tenant (RN-TEN-01). Todo el trabajo de negocio
   * ocurre en una sola transacción con contexto de tenant.
   */
  async provisionTenant(input: {
    name: string;
    planCode: string;
    owner: { email: string; password: string; fullName: string };
  }): Promise<{ tenantId: string; ownerUserId: string }> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO ten_tenants (name, plan_id, country, currency, timezone, settings)
       SELECT $1, p.id, 'PE', 'PEN', 'America/Lima', $2::jsonb
         FROM ten_plans p WHERE p.code = $3
       RETURNING id`,
      [
        input.name,
        JSON.stringify({ igvBps: 1800, locale: 'es-PE' }),
        input.planCode,
      ],
    );
    const tenantId = rows[0]?.id;
    if (!tenantId) {
      throw new NotFoundError(`Plan no encontrado: ${input.planCode}.`);
    }

    const ownerUserId = await withTenant(this.pool, tenantId, async (ctx) => {
      await seedSystemRoles(ctx);
      const userId = await createOwnerUser(ctx, input.owner);

      // Flags por defecto del plan.
      const { rows: featureRows } = await ctx.client.query<{
        features: Record<string, boolean>;
      }>(
        `SELECT p.features FROM ten_tenants t JOIN ten_plans p ON p.id = t.plan_id
          WHERE t.id = $1`,
        [tenantId],
      );
      const features = featureRows[0]?.features ?? {};
      const flagValues = Object.entries(features).map(([flag, enabled]) => ({
        tenantId,
        flag,
        enabled: Boolean(enabled),
      }));
      if (flagValues.length > 0) {
        await ctx.db
          .insert(schema.featureFlags)
          .values(flagValues)
          .onConflictDoNothing();
      }

      await recordAudit(ctx, {
        actorType: 'system',
        action: 'tenant.created',
        resourceType: 'tenant',
        resourceId: tenantId,
        data: { plan: input.planCode, owner: input.owner.email },
      });
      return userId;
    });

    return { tenantId, ownerUserId };
  }

  /** Suspende un tenant (RN-TEN-03): bloquea acceso, no borra datos. */
  async suspend(tenantId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE ten_tenants SET status = 'suspended', updated_at = now() WHERE id = $1`,
      [tenantId],
    );
    await withTenant(this.pool, tenantId, async (ctx) => {
      await recordAudit(ctx, {
        actorType: 'support',
        action: 'tenant.suspended',
        resourceType: 'tenant',
        resourceId: tenantId,
        reason,
      });
    });
  }

  /** Feature flags efectivos del tenant. */
  async getFlags(tenantId: string): Promise<Record<string, boolean>> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.featureFlags)
        .where(eq(schema.featureFlags.tenantId, tenantId));
      return Object.fromEntries(rows.map((r) => [r.flag, r.enabled]));
    });
  }
}
