import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import {
  AuditQueryService,
  type EntradaDeAuditoria,
} from '../app/audit-query.service.js';

/**
 * Consulta de auditoría (spec 17, docs/14#auditoria).
 *
 * Requiere `audit.read` (administrador/contador según docs/03). Es de solo
 * lectura y lo será siempre: `audit_log` es append-only y el rol de aplicación
 * no tiene `UPDATE` ni `DELETE` sobre ella (migración 0002), así que no hay
 * ninguna ruta que pueda corregir el histórico ni conviene que la haya.
 */
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @RequirePermission('audit.read')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('action') action?: string,
    @Query('entity') entity?: string,
    @Query('resource') resource?: string,
    @Query('actor') actor?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: EntradaDeAuditoria[] }> {
    // El tenant SIEMPRE sale del token, nunca de la query (CLAUDE.md).
    const items = await this.audit.list(req.auth!.tid, {
      ...(action ? { action } : {}),
      ...(entity ? { resourceType: entity } : {}),
      ...(resource ? { resourceId: resource } : {}),
      ...(actor ? { actorId: actor } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(limit ? { limit: Number(limit) || 100 } : {}),
    });
    return { items };
  }

  /** Las acciones registradas, para que el filtro ofrezca lo que HAY. */
  @Get('actions')
  @RequirePermission('audit.read')
  async actions(
    @Req() req: AuthenticatedRequest,
  ): Promise<Array<{ action: string; count: number }>> {
    return this.audit.actions(req.auth!.tid);
  }
}
