import { Controller, Get, Req } from '@nestjs/common';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import {
  OnboardingService,
  type ChecklistDeSalida,
} from '../app/onboarding.service.js';

/** La checklist de salida en vivo (docs/26 §5). */
@Controller({ path: 'onboarding', version: '1' })
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  /**
   * Con `tenant.read`: es el estado de la puesta en marcha del propio negocio,
   * no un dato de operación. El supervisor lo ve —es quien suele terminarla—;
   * el cajero no, porque ninguno de los pasos es suyo y una lista de tareas
   * ajenas en la pantalla de quien cobra es ruido.
   */
  @Get('checklist')
  @RequirePermission('tenant.read')
  checklist(@Req() req: AuthenticatedRequest): Promise<ChecklistDeSalida> {
    return this.onboarding.checklist(req.auth!.tid);
  }
}
