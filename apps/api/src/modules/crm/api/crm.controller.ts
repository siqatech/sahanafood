import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  CrmService,
  type ClienteResumen,
  type FichaDeCliente,
} from '../app/crm.service.js';

/** Clientes: perfil unificado e historial (spec 14, la parte de F5). */
@Controller({ path: 'crm', version: '1' })
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('customers')
  @RequirePermission('crm.read')
  listar(
    @Req() req: AuthenticatedRequest,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<ClienteResumen[]> {
    return this.crm.listar(req.auth!.tid, {
      ...(q !== undefined ? { search: q } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  /**
   * El teléfono va en la ruta y viene codificado: un `+51987654321` sin
   * `encodeURIComponent` llega como espacio en vez de `+`, y el cliente «no
   * existe» por un motivo que nadie adivina desde la pantalla.
   */
  @Get('customers/:phone')
  @RequirePermission('crm.read')
  ficha(
    @Req() req: AuthenticatedRequest,
    @Param('phone') phone: string,
  ): Promise<FichaDeCliente> {
    return this.crm.ficha(req.auth!.tid, decodeURIComponent(phone));
  }

  /**
   * Anonimizar a solicitud (RN-CRM-02, Ley 29733).
   *
   * Permiso propio y no `crm.read`: es IRREVERSIBLE y toca datos personales.
   * Quien consulta el teléfono de un cliente no es necesariamente quien puede
   * borrarlo para siempre, y por eso solo lo tienen propietario y
   * administrador.
   */
  @Post('customers/:phone/anonymize')
  @RequirePermission('crm.anonymize')
  anonimizar(
    @Req() req: AuthenticatedRequest,
    @Param('phone') phone: string,
    @Body() body: unknown,
  ): Promise<{ pedidos: number }> {
    const parsed = z
      .object({ reason: z.string().min(3).max(500) })
      .safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        'Escribe por qué se anonimiza: es una solicitud del cliente y queda en el histórico.',
      );
    }
    return this.crm.anonimizar(req.auth!.tid, decodeURIComponent(phone), {
      motivo: parsed.data.reason,
      actorId: req.auth!.sub,
    });
  }
}
