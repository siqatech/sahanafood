import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '../../../common/errors.js';
import {
  PERMISSION_KEY,
  type AuthenticatedRequest,
  type PermissionRequirement,
} from '../../../common/authz.js';
import { AuthService, claimsAllow } from '../app/auth.service.js';
import type { Permission } from '../domain/permissions.js';

/**
 * Guard global que hace cumplir `@RequirePermission` (criterio de aceptación de
 * la spec 02). El decorador vive en `common/authz.ts`; aquí está la
 * verificación, que necesita AuthService.
 *
 * Comportamiento:
 *  - Si hay cabecera Bearer, se valida y las claims quedan en `req.auth`.
 *  - Endpoint sin decorador = público explícito.
 *  - Endpoint con decorador exige permiso y, si aplica, ámbito del recurso.
 */
@Injectable()
export class RequirePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<
      PermissionRequirement | undefined
    >(PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const header = req.header('authorization');
    if (header?.startsWith('Bearer ')) {
      req.auth = this.auth.verifyAccessToken(header.slice('Bearer '.length));
    }

    if (!requirement) return true;

    if (!req.auth) {
      throw new ForbiddenError('Se requiere autenticación.');
    }

    const scope = requirement.scope
      ? {
          scopeType: requirement.scope.scopeType,
          scopeId: (req.params as Record<string, string>)[
            requirement.scope.param
          ] as string,
        }
      : undefined;

    if (!claimsAllow(req.auth, requirement.permission as Permission, scope)) {
      throw new ForbiddenError(
        `No tienes el permiso requerido: ${requirement.permission}.`,
      );
    }
    return true;
  }
}
