import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';
import { AuthService, type AuthTokens } from './auth.service.js';
import { DeviceService } from './device.service.js';

/**
 * Sesión del POS: **dispositivo emparejado + PIN del cajero** (spec 02, ux/01).
 *
 * Existe porque faltaba el cable. `pairDevice` emitía un `deviceToken` y
 * `authenticateDevice` sabía validarlo, pero **nadie lo llamaba desde HTTP**:
 * una tablet emparejada tenía una credencial y ninguna forma de usarla. Es el
 * mismo patrón que ya apareció tres veces en este proyecto —la pieza construida
 * que nadie conecta— y aquí dejaba al POS entero sin manera de autenticarse.
 *
 * ### Por qué dos factores y no uno
 *
 * El **dispositivo** dice *dónde* se está vendiendo; el **PIN** dice *quién*
 * vende. Hacen falta los dos y por motivos distintos:
 *
 *  · Solo con contraseña, el cajero la teclearía veinte veces al día en una
 *    tablet con grasa y delante de la cola. Acabaría escrita en un papel pegado
 *    a la caja. Un PIN de cuatro dígitos con bloqueo por intentos es lo que la
 *    gente sí usa.
 *  · Solo con PIN, cuatro dígitos serían la única barrera desde cualquier
 *    navegador de internet. Con el dispositivo por delante, el PIN solo sirve
 *    **en la tablet del local**, y una tablet robada se revoca de un clic.
 *
 * El `deviceToken` no es un token de sesión: no da acceso a nada por sí solo,
 * solo permite listar quién puede entrar en ese local y canjear un PIN. Todo lo
 * demás va con el access token del usuario, que es donde vive el tenant.
 */

export interface OperadorDelPos {
  userId: string;
  fullName: string;
}

export interface ContextoDelDispositivo {
  deviceId: string;
  deviceName: string;
  locationId: string | null;
}

@Injectable()
export class PosSessionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly devices: DeviceService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Quién puede entrar en esta tablet.
   *
   * Solo usuarios **activos y con PIN configurado**: enseñar a alguien sin PIN
   * sería ofrecer una puerta que no abre, y en un mostrador con cola eso son
   * treinta segundos de gente probando.
   *
   * No devuelve correos ni roles. La lista se enseña en una pantalla que
   * cualquiera ve desde el otro lado del mostrador.
   */
  async operadores(deviceToken: string): Promise<{
    device: ContextoDelDispositivo;
    operators: OperadorDelPos[];
  }> {
    const device = await this.devices.authenticateDevice(deviceToken);

    return withTenant(this.pool, device.tenantId, async (ctx) => {
      const { rows: nombre } = await ctx.client.query<{ name: string }>(
        'SELECT name FROM idn_devices WHERE id = $1',
        [device.deviceId],
      );

      const { rows } = await ctx.client.query<{
        id: string;
        full_name: string;
      }>(
        `SELECT u.id, u.full_name
           FROM idn_users u
           JOIN idn_user_pins p ON p.user_id = u.id AND p.tenant_id = u.tenant_id
          WHERE u.status = 'active'
          ORDER BY u.full_name`,
      );

      return {
        device: {
          deviceId: device.deviceId,
          deviceName: nombre[0]?.name ?? 'Dispositivo',
          locationId: device.locationId,
        },
        operators: rows.map((r) => ({ userId: r.id, fullName: r.full_name })),
      };
    });
  }

  /**
   * Canjea dispositivo + PIN por una sesión de usuario normal.
   *
   * El orden importa: **primero el dispositivo**. Si se verificara el PIN
   * antes, cualquiera desde internet podría probar PINs contra la cuenta de un
   * cajero hasta bloquearla — un ataque de denegación barato que dejaría al
   * mostrador sin poder cobrar en plena hora punta.
   */
  async entrar(input: {
    deviceToken: string;
    userId: string;
    pin: string;
    ip?: string | undefined;
    userAgent?: string | undefined;
    traceId?: string | undefined;
  }): Promise<AuthTokens & { locationId: string | null }> {
    const device = await this.devices.authenticateDevice(input.deviceToken);

    await this.devices.verifyPin(device.tenantId, input.userId, input.pin, {
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    });

    const tokens = await this.auth.issueSessionForVerifiedUser(
      device.tenantId,
      input.userId,
      {
        ...(input.ip !== undefined ? { ip: input.ip } : {}),
        ...(input.userAgent !== undefined
          ? { userAgent: input.userAgent }
          : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        via: `pos:${device.deviceId}`,
      },
    );

    // El local del dispositivo viaja con la sesión: el POS no lo elige ni lo
    // manda en el pedido. Si lo eligiera, una tablet del local A podría vender
    // en nombre del local B y la caja no cuadraría en ninguno de los dos.
    return { ...tokens, locationId: device.locationId };
  }
}
