import { Controller, Get, Req } from '@nestjs/common';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import {
  TenancyService,
  type LimitsView,
  type TenantView,
} from '../app/tenancy.service.js';

/**
 * API del tenant propio (spec 01). No hay endpoint que reciba un tenant_id:
 * siempre se deriva del token (RN-T01, CLAUDE.md).
 */
@Controller({ path: 'tenant', version: '1' })
export class TenantController {
  constructor(private readonly tenancy: TenancyService) {}

  @Get()
  @RequirePermission('tenant.read')
  get(@Req() req: AuthenticatedRequest): Promise<TenantView> {
    return this.tenancy.getTenant(req.auth!.tid);
  }

  @Get('limits')
  @RequirePermission('tenant.read')
  limits(@Req() req: AuthenticatedRequest): Promise<LimitsView> {
    return this.tenancy.getLimits(req.auth!.tid);
  }

  @Get('flags')
  @RequirePermission('tenant.read')
  flags(@Req() req: AuthenticatedRequest): Promise<Record<string, boolean>> {
    return this.tenancy.getFlags(req.auth!.tid);
  }
}
