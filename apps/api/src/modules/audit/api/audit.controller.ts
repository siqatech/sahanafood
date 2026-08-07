import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';

/**
 * Consulta de auditoría (spec 17): GET /audit?entity&actor&range.
 * Requiere permiso `audit.read` (admin/contador según docs/03).
 */
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  @RequirePermission('audit.read')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('entity') entity?: string,
    @Query('actor') actor?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: unknown[] }> {
    // El tenant SIEMPRE sale del token, nunca de la query (CLAUDE.md).
    const tenantId = req.auth!.tid;
    const take = Math.min(Number(limit ?? 100) || 100, 500);

    const items = await withTenant(this.pool, tenantId, async (ctx) => {
      const filters: SQL[] = [];
      if (entity) filters.push(eq(schema.auditLog.resourceType, entity));
      if (actor) filters.push(eq(schema.auditLog.actorId, actor));
      if (from) filters.push(gte(schema.auditLog.occurredAt, new Date(from)));
      if (to) filters.push(lte(schema.auditLog.occurredAt, new Date(to)));

      const query = ctx.db.select().from(schema.auditLog);
      const filtered =
        filters.length > 0 ? query.where(and(...filters)) : query;

      return filtered.orderBy(desc(schema.auditLog.occurredAt)).limit(take);
    });

    return { items };
  }
}
