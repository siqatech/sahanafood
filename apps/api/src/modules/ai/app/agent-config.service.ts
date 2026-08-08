import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Condition, Action } from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';

/**
 * Configuración del agente, versionada (spec 19 §2.8, RN-AIA-04, T5.29).
 *
 * **Publicar es crear una versión inmutable, no editar la vigente.** Dos cosas
 * dependen de eso:
 *
 *  · **Rollback en un clic**: volver atrás es apuntar a otra fila, no
 *    reconstruir una configuración de memoria.
 *  · **RN-AIA-04**: lo publicado aplica a chats NUEVOS; los activos terminan
 *    con su versión. Sin inmutabilidad, cambiar el tono a media tarde haría
 *    que el agente cambiara de personalidad en mitad de una conversación.
 *
 * El borrador se edita cuanto haga falta y se prueba en el sandbox ANTES de
 * publicar. Es el patrón «vista previa» de Kommo, y existe porque la
 * alternativa —editar en vivo y ver qué pasa— se prueba con clientes reales.
 */

export interface AgentIdentity {
  name?: string | undefined;
  role?: string | undefined;
  personality?: string | undefined;
  tone?: 'amistoso' | 'formal' | 'juvenil' | undefined;
  length?: 'corta' | 'media' | undefined;
  emojis?: boolean | undefined;
}

export interface AgentLimits {
  forbiddenTopics?: string[] | undefined;
  handoffMessage?: string | undefined;
}

export interface ConfigView {
  id: string;
  brandId: string;
  version: number;
  status: string;
  identity: AgentIdentity;
  guidelines: string[];
  limits: AgentLimits;
  enabled: boolean;
  publishedAt: string | null;
  rules: Array<{
    id: string;
    name: string;
    priority: number;
    matchMode: string;
    conditions: Condition[];
    actions: Action[];
    enabled: boolean;
    activeFromMinute: number | null;
    activeToMinute: number | null;
    hitCount: number;
  }>;
}

@Injectable()
export class AgentConfigService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** El borrador de una marca. Se crea vacío la primera vez. */
  async getDraft(tenantId: string, brandId: string): Promise<ConfigView> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ id: string }>(
        `SELECT id FROM ai_agent_configs
          WHERE brand_id = $1 AND status = 'draft'
          ORDER BY version DESC LIMIT 1`,
        [brandId],
      );
      if (rows[0]) return this.load(ctx, rows[0].id);

      const { rows: nuevo } = await ctx.client.query<{ id: string }>(
        `INSERT INTO ai_agent_configs (tenant_id, brand_id, version, status)
         VALUES ($1,$2, COALESCE(
           (SELECT max(version) + 1 FROM ai_agent_configs
             WHERE tenant_id = $1 AND brand_id = $2), 1), 'draft')
         RETURNING id`,
        [tenantId, brandId],
      );
      return this.load(ctx, nuevo[0]!.id);
    });
  }

  async updateDraft(
    tenantId: string,
    configId: string,
    input: {
      identity?: AgentIdentity | undefined;
      guidelines?: string[] | undefined;
      limits?: AgentLimits | undefined;
      enabled?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<ConfigView> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.assertDraft(ctx, configId);
      await ctx.client.query(
        `UPDATE ai_agent_configs
            SET identity = COALESCE($2::jsonb, identity),
                guidelines = COALESCE($3::jsonb, guidelines),
                limits = COALESCE($4::jsonb, limits),
                enabled = COALESCE($5, enabled)
          WHERE id = $1`,
        [
          configId,
          input.identity ? JSON.stringify(input.identity) : null,
          input.guidelines ? JSON.stringify(input.guidelines) : null,
          input.limits ? JSON.stringify(input.limits) : null,
          input.enabled ?? null,
        ],
      );
      return this.load(ctx, configId);
    });
  }

  async addRule(
    tenantId: string,
    configId: string,
    input: {
      name: string;
      priority?: number | undefined;
      matchMode?: 'any' | 'all' | undefined;
      conditions: Condition[];
      actions: Action[];
      activeFromMinute?: number | null | undefined;
      activeToMinute?: number | null | undefined;
    },
  ): Promise<{ id: string }> {
    if (input.conditions.length === 0) {
      throw new ValidationError('Una regla sin condiciones no dispara nunca.');
    }
    if (input.actions.length === 0) {
      throw new ValidationError('Una regla sin acciones no hace nada.');
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.assertDraft(ctx, configId);
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO ai_rules
           (tenant_id, config_id, name, priority, match_mode, conditions,
            actions, active_from_minute, active_to_minute)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          tenantId,
          configId,
          input.name,
          input.priority ?? 100,
          input.matchMode ?? 'any',
          JSON.stringify(input.conditions),
          JSON.stringify(input.actions),
          input.activeFromMinute ?? null,
          input.activeToMinute ?? null,
        ],
      );
      return { id: rows[0]!.id };
    });
  }

  /**
   * Publica el borrador. A partir de aquí es inmutable.
   *
   * La anterior pasa a `archived` y no se borra: es lo que hace posible el
   * rollback y lo que permite responder «¿qué tenía configurado el agente el
   * martes?» cuando un cliente reclame por algo que se le dijo.
   */
  async publish(
    tenantId: string,
    configId: string,
    actorId?: string,
  ): Promise<ConfigView> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const config = await this.load(ctx, configId);
      if (config.status !== 'draft') {
        throw new ValidationError('Solo se publica un borrador.');
      }

      await ctx.client.query(
        `UPDATE ai_agent_configs SET status = 'archived'
          WHERE brand_id = $1 AND status = 'published'`,
        [config.brandId],
      );
      await ctx.client.query(
        `UPDATE ai_agent_configs
            SET status = 'published', published_at = now(), published_by = $2
          WHERE id = $1`,
        [configId, actorId ?? null],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: 'ai.config_published',
        resourceType: 'ai_config',
        resourceId: configId,
        data: { brandId: config.brandId, version: config.version },
      });

      return this.load(ctx, configId);
    });
  }

  /**
   * Rollback: vuelve a una versión archivada.
   *
   * No copia nada: cambia qué fila está publicada. Copiar reconstruiría la
   * configuración y el resultado podría diferir del original por un campo
   * añadido después — que es justo el fallo que un rollback no puede tener.
   */
  async rollback(
    tenantId: string,
    configId: string,
    actorId?: string,
  ): Promise<ConfigView> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const config = await this.load(ctx, configId);
      if (config.status !== 'archived') {
        throw new ValidationError(
          'Solo se puede volver a una versión archivada.',
        );
      }

      await ctx.client.query(
        `UPDATE ai_agent_configs SET status = 'archived'
          WHERE brand_id = $1 AND status = 'published'`,
        [config.brandId],
      );
      await ctx.client.query(
        `UPDATE ai_agent_configs SET status = 'published', published_at = now()
          WHERE id = $1`,
        [configId],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: 'ai.config_rolled_back',
        resourceType: 'ai_config',
        resourceId: configId,
        data: { brandId: config.brandId, version: config.version },
      });

      return this.load(ctx, configId);
    });
  }

  async listVersions(
    tenantId: string,
    brandId: string,
  ): Promise<
    Array<{ id: string; version: number; status: string; publishedAt: string | null }>
  > {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        version: number;
        status: string;
        published_at: Date | null;
      }>(
        `SELECT id, version, status, published_at FROM ai_agent_configs
          WHERE brand_id = $1 ORDER BY version DESC`,
        [brandId],
      );
      return rows.map((r) => ({
        id: r.id,
        version: r.version,
        status: r.status,
        publishedAt: r.published_at?.toISOString() ?? null,
      }));
    });
  }

  // ----------------------------------------------------------------- Apoyo

  private async assertDraft(
    ctx: TenantContext,
    configId: string,
  ): Promise<void> {
    const { rows } = await ctx.client.query<{ status: string }>(
      'SELECT status FROM ai_agent_configs WHERE id = $1',
      [configId],
    );
    if (!rows[0]) throw new NotFoundError('Configuración no encontrada.');
    if (rows[0].status !== 'draft') {
      // Una versión publicada NO se toca. Editarla cambiaría lo que respondió
      // el agente ayer sin dejar rastro, y la traza de RN-AIA-05 dejaría de
      // ser reproducible.
      throw new ValidationError(
        'Una versión publicada es inmutable: crea un borrador nuevo.',
      );
    }
  }

  private async load(ctx: TenantContext, id: string): Promise<ConfigView> {
    const { rows } = await ctx.client.query<{
      id: string;
      brand_id: string;
      version: number;
      status: string;
      identity: AgentIdentity;
      guidelines: string[];
      limits: AgentLimits;
      enabled: boolean;
      published_at: Date | null;
    }>(
      `SELECT id, brand_id, version, status, identity, guidelines, limits,
              enabled, published_at
         FROM ai_agent_configs WHERE id = $1`,
      [id],
    );
    const c = rows[0];
    if (!c) throw new NotFoundError('Configuración no encontrada.');

    const { rows: reglas } = await ctx.client.query<{
      id: string;
      name: string;
      priority: number;
      match_mode: string;
      conditions: Condition[];
      actions: Action[];
      enabled: boolean;
      active_from_minute: number | null;
      active_to_minute: number | null;
      hit_count: number;
    }>(
      `SELECT id, name, priority, match_mode, conditions, actions, enabled,
              active_from_minute, active_to_minute, hit_count
         FROM ai_rules WHERE config_id = $1 ORDER BY priority, id`,
      [id],
    );

    return {
      id: c.id,
      brandId: c.brand_id,
      version: c.version,
      status: c.status,
      identity: c.identity,
      guidelines: c.guidelines,
      limits: c.limits,
      enabled: c.enabled,
      publishedAt: c.published_at?.toISOString() ?? null,
      rules: reglas.map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        matchMode: r.match_mode,
        conditions: r.conditions,
        actions: r.actions,
        enabled: r.enabled,
        activeFromMinute: r.active_from_minute,
        activeToMinute: r.active_to_minute,
        hitCount: r.hit_count,
      })),
    };
  }
}
