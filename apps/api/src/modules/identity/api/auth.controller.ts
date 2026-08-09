import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ForbiddenError, ValidationError } from '../../../common/errors.js';
import { AuthService, type AuthTokens } from '../app/auth.service.js';
import type { AuthenticatedRequest } from '../../../common/authz.js';

/**
 * Endpoints de autenticación (spec 02). Validación con zod en el borde
 * (convenciones docs/29); el dominio asume datos ya válidos.
 */

const loginSchema = z.object({
  email: z.string().email('Email inválido.'),
  password: z
    .string()
    .min(8, 'La contraseña debe tener al menos 8 caracteres.'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10, 'Token de refresco inválido.'),
});

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

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<AuthTokens> {
    const dto = parse(loginSchema, body);
    return this.auth.login(dto.email, dto.password, {
      ...(req.ip !== undefined ? { ip: req.ip } : {}),
      ...(req.header('user-agent') !== undefined
        ? { userAgent: req.header('user-agent')! }
        : {}),
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  @Post('refresh')
  async refresh(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<AuthTokens> {
    const dto = parse(refreshSchema, body);
    return this.auth.refresh(dto.refreshToken, {
      ...(req.ip !== undefined ? { ip: req.ip } : {}),
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  @Post('logout')
  async logout(@Body() body: unknown): Promise<{ ok: true }> {
    const dto = parse(refreshSchema, body);
    await this.auth.logout(dto.refreshToken);
    return { ok: true };
  }

  /**
   * Perfil de la sesión actual: quién soy y qué puedo hacer.
   *
   * **Sin `@RequirePermission`, y a propósito.** Llevaba `tenant.read`, que un
   * cajero no tiene: el POS entraba con su PIN, recibía un token válido y lo
   * primero que hacía —preguntar quién es— le respondía 403. Lo destapó la
   * prueba de sesión del POS al comprobar que el token *sirve para algo*, no
   * solo que se emite.
   *
   * Preguntar por la propia sesión no es leer la configuración del tenant: no
   * devuelve nada que quien trae el token no tenga ya. Exigir un permiso aquí
   * es pedir autorización para leerse a uno mismo. Sin token responde 403,
   * igual que cualquier endpoint protegido, porque no hay sesión de la que
   * hablar.
   */
  @Get('me')
  me(@Req() req: AuthenticatedRequest): {
    userId: string;
    tenantId: string;
    permissions: string[];
  } {
    const auth = req.auth;
    if (!auth) throw new ForbiddenError('Se requiere autenticación.');
    return {
      userId: auth.sub,
      tenantId: auth.tid,
      permissions: auth.permissions,
    };
  }
}
