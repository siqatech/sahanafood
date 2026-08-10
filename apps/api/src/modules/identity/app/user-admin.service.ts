import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { AuthService } from './auth.service.js';
import { SYSTEM_ROLES } from '../domain/permissions.js';

/**
 * Alta y roles del EQUIPO (spec 02, `specs/ux/03` → Configuración/usuarios).
 *
 * Faltaba entero, y su ausencia no se ve mirando la API: los nueve roles del
 * sistema se crean en cada tenant, el guardia los comprueba en cada petición y
 * el POS entra con usuario + PIN… pero **no había forma de crear un segundo
 * usuario**. El único que existe es el propietario que nace con el tenant.
 *
 * En un local eso significa que el dueño acaba dándole SU contraseña al cajero
 * —que es la cuenta con todos los permisos, la que aprueba descuadres y la que
 * firma en auditoría—. La trazabilidad que sostiene `audit_log` se vuelve
 * ficción el primer día: todo lo hizo el dueño, incluso lo que hizo el cocinero
 * a las once de la noche.
 */

export interface UsuarioDelEquipo {
  id: string;
  email: string;
  fullName: string;
  status: string;
  isOwner: boolean;
  hasPin: boolean;
  roles: Array<{ code: string; name: string; scopeType: string }>;
}

/** Roles que un administrador puede asignar. `owner` NO está: ver abajo. */
export const ROLES_ASIGNABLES = SYSTEM_ROLES.filter(
  (r) => r.code !== 'owner',
).map((r) => ({ code: r.code, name: r.name }));

@Injectable()
export class UserAdminService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(tenantId: string): Promise<UsuarioDelEquipo[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        id: string;
        email: string;
        full_name: string;
        status: string;
        is_owner: boolean;
        has_pin: boolean;
        roles: Array<{ code: string; name: string; scope_type: string }> | null;
      }>(
        `SELECT u.id, u.email, u.full_name, u.status, u.is_owner,
                EXISTS (SELECT 1 FROM idn_user_pins p WHERE p.user_id = u.id)
                  AS has_pin,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                            'code', r.code, 'name', r.name,
                            'scope_type', ur.scope_type))
                     FROM idn_user_roles ur
                     JOIN idn_roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id),
                  '[]'::json
                ) AS roles
           FROM idn_users u
          ORDER BY u.is_owner DESC, u.full_name`,
      );

      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        fullName: r.full_name,
        status: r.status,
        isOwner: r.is_owner,
        hasPin: r.has_pin,
        roles: (r.roles ?? []).map((x) => ({
          code: x.code,
          name: x.name,
          scopeType: x.scope_type,
        })),
      }));
    });
  }

  /**
   * Da de alta a una persona del equipo con su rol.
   *
   * **El rol es obligatorio.** Un usuario sin rol entra y no puede hacer nada,
   * y lo que ocurre entonces es que alguien le presta una cuenta con permisos
   * «mientras tanto» — el atajo que esta pantalla existe para evitar. Pedirlo
   * aquí cuesta un desplegable; no pedirlo cuesta la trazabilidad entera.
   *
   * **`owner` no se puede asignar.** Es el rol que nace con el tenant y el que
   * puede cambiarlo todo, incluida la facturación del propio SaaS. Que un
   * administrador pueda fabricar otro propietario convierte cualquier cuenta
   * comprometida de administrador en una toma de control permanente.
   */
  async create(
    tenantId: string,
    input: {
      email: string;
      fullName: string;
      password: string;
      roleCode: string;
      actorId?: string | undefined;
    },
  ): Promise<UsuarioDelEquipo> {
    const email = input.email.trim().toLowerCase();
    const nombre = input.fullName.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ValidationError(`"${input.email}" no es un correo válido.`);
    }
    if (nombre.length < 2) {
      throw new ValidationError('La persona necesita un nombre.');
    }
    // La misma longitud que exige el alta de tenant: no tiene sentido que la
    // cuenta del cajero sea más fácil de adivinar que la del dueño.
    if (input.password.length < 12) {
      throw new ValidationError(
        'La contraseña debe tener al menos 12 caracteres.',
      );
    }
    if (input.roleCode === 'owner') {
      throw new ForbiddenError(
        'El rol de propietario no se asigna: nace con la cuenta.',
      );
    }

    const passwordHash = await AuthService.hashPassword(input.password);

    return withTenant(this.pool, tenantId, async (ctx) => {
      const rol = await this.exigeRol(ctx, input.roleCode);

      const { rows: repetido } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM idn_users WHERE lower(email) = $1',
        [email],
      );
      if (repetido[0]) {
        throw new ValidationError(
          `Ya hay alguien con el correo ${email} en este negocio.`,
        );
      }

      const [creado] = await ctx.db
        .insert(schema.users)
        .values({ tenantId, email, passwordHash, fullName: nombre })
        .returning({ id: schema.users.id });

      await ctx.db.insert(schema.userRoles).values({
        tenantId,
        userId: creado!.id,
        roleId: rol.id,
        scopeType: 'tenant',
        scopeId: null,
      });

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'identity.user_created',
        resourceType: 'user',
        resourceId: creado!.id,
        // El correo sí, la contraseña jamás: auditoría se exporta y se lee.
        data: { email, role: input.roleCode },
      });

      return (await this.leer(ctx, creado!.id))!;
    });
  }

  /**
   * Cambia el rol de una persona.
   *
   * Reemplaza los que tenga en vez de añadir. Acumular roles hace que quitar
   * un permiso exija saber cuántos se dieron antes, y en la práctica nadie lo
   * sabe: se acaba con cajeros que siguen pudiendo aprobar descuadres porque
   * un día cubrieron un turno de supervisor.
   */
  async setRole(
    tenantId: string,
    userId: string,
    roleCode: string,
    actorId?: string,
  ): Promise<UsuarioDelEquipo> {
    if (roleCode === 'owner') {
      throw new ForbiddenError(
        'El rol de propietario no se asigna: nace con la cuenta.',
      );
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      const usuario = await this.leer(ctx, userId);
      if (!usuario) throw new NotFoundError('Usuario no encontrado.');
      if (usuario.isOwner) {
        // Degradar al propietario deja el negocio sin nadie que pueda
        // recuperarlo: no hay un escalón por encima al que pedírselo.
        throw new ForbiddenError(
          'Al propietario no se le cambia el rol; es la única cuenta que no se puede dejar fuera.',
        );
      }

      const rol = await this.exigeRol(ctx, roleCode);
      await ctx.db
        .delete(schema.userRoles)
        .where(eq(schema.userRoles.userId, userId));
      await ctx.db.insert(schema.userRoles).values({
        tenantId,
        userId,
        roleId: rol.id,
        scopeType: 'tenant',
        scopeId: null,
      });

      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: 'identity.role_changed',
        resourceType: 'user',
        resourceId: userId,
        data: { role: roleCode },
      });

      return (await this.leer(ctx, userId))!;
    });
  }

  /**
   * Desactiva a una persona. No se borra.
   *
   * Su nombre está en cada pedido que tomó, en cada arqueo que cerró y en cada
   * línea de auditoría. Borrarla dejaría un histórico lleno de referencias a
   * nadie justo cuando alguien lo revisa por una diferencia de caja.
   */
  async setStatus(
    tenantId: string,
    userId: string,
    activo: boolean,
    actorId?: string,
  ): Promise<UsuarioDelEquipo> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const usuario = await this.leer(ctx, userId);
      if (!usuario) throw new NotFoundError('Usuario no encontrado.');
      if (usuario.isOwner && !activo) {
        throw new ForbiddenError(
          'El propietario no se puede desactivar: nadie podría volver a entrar.',
        );
      }

      await ctx.db
        .update(schema.users)
        .set({ status: activo ? 'active' : 'disabled', updatedAt: new Date() })
        .where(eq(schema.users.id, userId));

      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: activo ? 'identity.user_enabled' : 'identity.user_disabled',
        resourceType: 'user',
        resourceId: userId,
        data: {},
      });

      return (await this.leer(ctx, userId))!;
    });
  }

  // ------------------------------------------------------------- Internos

  private async exigeRol(
    ctx: TenantContext,
    code: string,
  ): Promise<{ id: string }> {
    const filas = await ctx.db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.code, code)))
      .limit(1);
    if (!filas[0]) {
      throw new ValidationError(
        `El rol "${code}" no existe. Los disponibles son: ${ROLES_ASIGNABLES.map((r) => r.code).join(', ')}.`,
      );
    }
    return filas[0];
  }

  private async leer(
    ctx: TenantContext,
    userId: string,
  ): Promise<UsuarioDelEquipo | null> {
    const { rows } = await ctx.client.query<{
      id: string;
      email: string;
      full_name: string;
      status: string;
      is_owner: boolean;
      has_pin: boolean;
      roles: Array<{ code: string; name: string; scope_type: string }> | null;
    }>(
      `SELECT u.id, u.email, u.full_name, u.status, u.is_owner,
              EXISTS (SELECT 1 FROM idn_user_pins p WHERE p.user_id = u.id)
                AS has_pin,
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'code', r.code, 'name', r.name,
                          'scope_type', ur.scope_type))
                   FROM idn_user_roles ur
                   JOIN idn_roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id),
                '[]'::json
              ) AS roles
         FROM idn_users u WHERE u.id = $1`,
      [userId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      status: r.status,
      isOwner: r.is_owner,
      hasPin: r.has_pin,
      roles: (r.roles ?? []).map((x) => ({
        code: x.code,
        name: x.name,
        scopeType: x.scope_type,
      })),
    };
  }
}
