import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  UserAdminService,
  ROLES_ASIGNABLES,
  type UsuarioDelEquipo,
} from '../app/user-admin.service.js';

/**
 * El equipo: alta, rol y baja (spec 02, `specs/ux/03` → Configuración).
 *
 * Todo bajo `users.write` salvo la lectura. Es el permiso que ya existía y que
 * hasta ahora solo servía para emitir códigos de emparejamiento — porque no
 * había nada más que gestionar.
 */

const altaSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2).max(160),
  password: z.string().min(12, 'La contraseña necesita 12 caracteres.'),
  roleCode: z.string().min(2).max(40),
});

const rolSchema = z.object({ roleCode: z.string().min(2).max(40) });
const estadoSchema = z.object({ active: z.boolean() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => i.message).join(' '),
      { errors: result.error.issues },
    );
  }
  return result.data;
}

@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UserAdminService) {}

  @Get()
  @RequirePermission('users.read')
  list(@Req() req: AuthenticatedRequest): Promise<UsuarioDelEquipo[]> {
    return this.users.list(req.auth!.tid);
  }

  /**
   * Los roles que se pueden asignar.
   *
   * Se sirven desde el servidor y no se escriben en la pantalla: son los
   * mismos nueve que el guardia comprueba, y una lista duplicada en el panel
   * se desviaría el día que se añada uno — ofreciendo un rol que no existe o
   * escondiendo uno que sí.
   */
  @Get('roles')
  @RequirePermission('users.read')
  roles(): Array<{ code: string; name: string }> {
    return ROLES_ASIGNABLES;
  }

  @Post()
  @RequirePermission('users.write')
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<UsuarioDelEquipo> {
    const dto = parse(altaSchema, body);
    return this.users.create(req.auth!.tid, {
      ...dto,
      actorId: req.auth!.sub,
    });
  }

  @Post(':id/role')
  @RequirePermission('users.write')
  setRole(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<UsuarioDelEquipo> {
    const dto = parse(rolSchema, body);
    return this.users.setRole(req.auth!.tid, id, dto.roleCode, req.auth!.sub);
  }

  @Post(':id/status')
  @RequirePermission('users.write')
  setStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<UsuarioDelEquipo> {
    const dto = parse(estadoSchema, body);
    return this.users.setStatus(req.auth!.tid, id, dto.active, req.auth!.sub);
  }
}
