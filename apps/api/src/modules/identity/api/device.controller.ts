import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import { DeviceService, type PairedDevice } from '../app/device.service.js';
import {
  PosSessionService,
  type ContextoDelDispositivo,
  type OperadorDelPos,
} from '../app/pos-session.service.js';

/**
 * Dispositivos POS y PIN de operador (spec 02: POST /devices/pair,
 * POST /auth/pin-verify).
 */

const pairSchema = z.object({
  code: z.string().min(4, 'Código de emparejamiento inválido.'),
  deviceName: z.string().min(1).max(80),
});

const issueSchema = z.object({
  locationId: z.string().uuid().optional(),
});

const setPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, 'El PIN debe tener entre 4 y 6 dígitos.'),
  userId: z.string().uuid().optional(),
});

const verifyPinSchema = z.object({
  userId: z.string().uuid(),
  pin: z.string().min(4).max(6),
});

const revokeSchema = z.object({
  reason: z.string().min(3, 'Indica el motivo de la revocación.'),
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

@Controller({ path: '', version: '1' })
export class DeviceController {
  constructor(private readonly devices: DeviceService) {}

  /** Emite un código de emparejamiento de un solo uso (requiere administrador). */
  @Post('devices/pairing-codes')
  @RequirePermission('users.write')
  async issueCode(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ code: string; expiresAt: string }> {
    const dto = parse(issueSchema, body);
    const result = await this.devices.issuePairingCode(req.auth!.tid, {
      ...(dto.locationId !== undefined ? { locationId: dto.locationId } : {}),
      createdBy: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
    return { code: result.code, expiresAt: result.expiresAt.toISOString() };
  }

  /**
   * Canjea el código y empareja el dispositivo. Endpoint PÚBLICO por diseño: la
   * tablet aún no tiene credenciales; el código de un solo uso ES la credencial.
   */
  @Post('devices/pair')
  async pair(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<PairedDevice> {
    const dto = parse(pairSchema, body);
    return this.devices.pairDevice(dto.code, dto.deviceName, {
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  @Get('devices')
  @RequirePermission('users.read')
  list(@Req() req: AuthenticatedRequest): Promise<unknown[]> {
    return this.devices.listDevices(req.auth!.tid);
  }

  /** Revoca un dispositivo (tablet perdida). Motivo obligatorio para auditoría. */
  @Delete('devices/:id')
  @RequirePermission('users.write')
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const dto = parse(revokeSchema, body);
    await this.devices.revokeDevice(
      req.auth!.tid,
      id,
      req.auth!.sub,
      dto.reason,
    );
    return { ok: true };
  }

  /** Establece el PIN propio, o el de otro operador con permiso de gestión. */
  @Post('auth/pin')
  @RequirePermission('users.read')
  async setPin(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const dto = parse(setPinSchema, body);
    const target = dto.userId ?? req.auth!.sub;

    // Cambiar el PIN de OTRO operador exige permiso de gestión de usuarios.
    if (
      target !== req.auth!.sub &&
      !req.auth!.permissions.some((p) => p === 'users.write' || p === '*')
    ) {
      throw new ValidationError(
        'Solo puedes cambiar tu propio PIN sin el permiso users.write.',
      );
    }

    await this.devices.setPin(req.auth!.tid, target, dto.pin, {
      // Al fijarlo un administrador a otro, el operador deberá cambiarlo.
      mustChange: target !== req.auth!.sub,
      actorId: req.auth!.sub,
    });
    return { ok: true };
  }

  /** Verifica el PIN de un operador para una acción sensible del POS. */
  @Post('auth/pin-verify')
  @RequirePermission('orders.read')
  async verifyPin(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ ok: true; mustChange: boolean }> {
    const dto = parse(verifyPinSchema, body);
    return this.devices.verifyPin(req.auth!.tid, dto.userId, dto.pin, {
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }
}

/**
 * Sesión del POS: dispositivo + PIN (ux/01, «Sesión por PIN»).
 *
 * Controlador aparte y **público**, como el de emparejar, y por el mismo
 * motivo: la tablet todavía no tiene sesión de usuario cuando llama aquí. Lo
 * que la autoriza es el `deviceToken`, que se emitió al emparejarla contra un
 * código de un solo uso generado por alguien con `users.write`.
 *
 * El `deviceToken` va en el CUERPO y no en `Authorization`, deliberadamente:
 * no es un token de sesión —no da acceso a ningún dato de negocio— y ponerlo
 * en la misma cabecera que un access token invitaría a que el guard global
 * acabara aceptando uno donde espera el otro.
 */
@Controller({ path: 'auth', version: '1' })
export class PosSessionController {
  constructor(private readonly pos: PosSessionService) {}

  /** Quién puede entrar en esta tablet. Sin correos ni roles: se ve desde la cola. */
  @Post('pos/operators')
  operators(@Body() body: unknown): Promise<{
    device: ContextoDelDispositivo;
    operators: OperadorDelPos[];
  }> {
    const dto = parse(z.object({ deviceToken: z.string().min(20) }), body);
    return this.pos.operadores(dto.deviceToken);
  }

  /** Canjea dispositivo + PIN por una sesión de usuario normal. */
  @Post('pos/login')
  login(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    locationId: string | null;
  }> {
    const dto = parse(
      z.object({
        deviceToken: z.string().min(20),
        userId: z.string().uuid(),
        pin: z.string().min(4).max(6),
      }),
      body,
    );
    return this.pos.entrar({
      ...dto,
      ...(req.ip !== undefined ? { ip: req.ip } : {}),
      ...(req.header('user-agent') !== undefined
        ? { userAgent: req.header('user-agent')! }
        : {}),
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }
}
