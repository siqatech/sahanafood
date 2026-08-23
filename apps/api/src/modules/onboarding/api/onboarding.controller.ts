import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors.js';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import {
  OnboardingService,
  type ChecklistDeSalida,
  type ResultadoDePractica,
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

  /**
   * «Borrar la práctica y empezar en serio» (docs/26 §4).
   *
   * Con `tenant.update`, que solo tienen propietario y administrador: borra las
   * ventas del negocio entero. Un supervisor puede terminar la puesta en marcha
   * pero no vaciarla.
   *
   * El motivo es obligatorio y no es burocracia: es la única acción del panel
   * que borra ventas en bloque, y dentro de seis meses «¿por qué no hay nada
   * antes de marzo?» tiene que tener respuesta escrita.
   */
  @Post('go-live')
  @RequirePermission('tenant.update')
  empezarEnSerio(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ResultadoDePractica> {
    const parsed = z
      .object({ reason: z.string().min(3).max(500) })
      .safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Escribe por qué empiezas en serio: queda en el histórico.',
      );
    }
    return this.onboarding.empezarEnSerio(req.auth!.tid, {
      motivo: parsed.data.reason,
      actorId: req.auth!.sub,
    });
  }
}
