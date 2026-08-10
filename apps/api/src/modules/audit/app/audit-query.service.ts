import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';

/**
 * Lectura de `audit_log` (spec 17, docs/14#auditoria).
 *
 * El endpoint que existía devolvía las filas crudas: `actorId` es un UUID, y
 * una pantalla que dice «3f2a8c… cambió un precio» no responde la pregunta que
 * lleva a alguien a mirar la auditoría, que siempre es **quién**. El nombre no
 * se guarda en la fila a propósito —una persona se renombra y el histórico no
 * se reescribe— así que se resuelve al leer.
 *
 * Y se resuelve con `LEFT JOIN`: quien firmó puede haberse dado de baja, y
 * perder su línea del histórico por eso sería justo lo contrario de auditar.
 */

export interface EntradaDeAuditoria {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  /** Nombre de quien lo hizo, si sigue existiendo. */
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  traceId: string | null;
  data: Record<string, unknown>;
}

export interface FiltrosDeAuditoria {
  action?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  actorId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

@Injectable()
export class AuditQueryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(
    tenantId: string,
    filtros: FiltrosDeAuditoria = {},
  ): Promise<EntradaDeAuditoria[]> {
    const limite = Math.min(Math.max(filtros.limit ?? 100, 1), 500);

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        id: string;
        occurred_at: Date;
        actor_type: string;
        actor_id: string | null;
        actor_name: string | null;
        action: string;
        resource_type: string;
        resource_id: string | null;
        reason: string | null;
        trace_id: string | null;
        data: Record<string, unknown>;
      }>(
        `SELECT a.id, a.occurred_at, a.actor_type, a.actor_id,
                u.full_name AS actor_name,
                a.action, a.resource_type, a.resource_id, a.reason,
                a.trace_id, a.data
           FROM audit_log a
           -- actor_id es texto porque también guarda actores que no son
           -- usuarios; el cast solo se intenta cuando parece un UUID.
           LEFT JOIN idn_users u
             ON a.actor_type = 'user'
            AND a.actor_id ~ '^[0-9a-f-]{36}$'
            AND u.id = a.actor_id::uuid
          WHERE ($1::text IS NULL OR a.action = $1)
            AND ($2::text IS NULL OR a.resource_type = $2)
            AND ($3::text IS NULL OR a.resource_id = $3)
            AND ($4::text IS NULL OR a.actor_id = $4)
            AND ($5::timestamptz IS NULL OR a.occurred_at >= $5)
            AND ($6::timestamptz IS NULL OR a.occurred_at <= $6)
          ORDER BY a.occurred_at DESC
          LIMIT $7`,
        [
          filtros.action ?? null,
          filtros.resourceType ?? null,
          filtros.resourceId ?? null,
          filtros.actorId ?? null,
          filtros.from ?? null,
          filtros.to ?? null,
          limite,
        ],
      );

      return rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at.toISOString(),
        actorType: r.actor_type,
        actorId: r.actor_id,
        actorName: r.actor_name,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        reason: r.reason,
        traceId: r.trace_id,
        data: r.data ?? {},
      }));
    });
  }

  /**
   * Las acciones que este tenant tiene registradas, con cuántas veces.
   *
   * Se calcula en vez de fijarse en una lista: el desplegable de la pantalla
   * tiene que ofrecer lo que HAY, no lo que en teoría podría haber. Una lista
   * escrita a mano se desvía al añadir una acción, y ofrecer filtros que no
   * devuelven nada hace dudar de si el filtro falla o no pasó nunca.
   */
  async actions(
    tenantId: string,
  ): Promise<Array<{ action: string; count: number }>> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        action: string;
        count: string;
      }>(
        `SELECT action, count(*) AS count
           FROM audit_log GROUP BY action ORDER BY action`,
      );
      return rows.map((r) => ({ action: r.action, count: Number(r.count) }));
    });
  }
}
