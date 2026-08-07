import { eq } from 'drizzle-orm';
import type { TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import { AuthService } from './auth.service.js';
import { SYSTEM_ROLES } from '../domain/permissions.js';

/**
 * Provisión de identidad al crear un tenant (RN-TEN-01): roles del sistema y
 * usuario propietario. Se ejecuta dentro de la transacción de creación.
 */

/** Crea los roles del sistema del tenant. Idempotente por (tenant, code). */
export async function seedSystemRoles(ctx: TenantContext): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    const inserted = await ctx.db
      .insert(schema.roles)
      .values({
        tenantId: ctx.tenantId,
        code: role.code,
        name: role.name,
        isSystem: true,
      })
      .onConflictDoNothing()
      .returning({ id: schema.roles.id });

    const roleId =
      inserted[0]?.id ??
      (
        await ctx.db
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(eq(schema.roles.code, role.code))
          .limit(1)
      )[0]?.id;

    if (!roleId) continue;

    await ctx.db
      .insert(schema.rolePermissions)
      .values(
        role.permissions.map((permission) => ({
          tenantId: ctx.tenantId,
          roleId,
          permission,
        })),
      )
      .onConflictDoNothing();
  }
}

/** Crea el usuario propietario y le asigna el rol `owner` con ámbito de tenant. */
export async function createOwnerUser(
  ctx: TenantContext,
  input: { email: string; password: string; fullName: string },
): Promise<string> {
  const passwordHash = await AuthService.hashPassword(input.password);
  const [user] = await ctx.db
    .insert(schema.users)
    .values({
      tenantId: ctx.tenantId,
      email: input.email.trim().toLowerCase(),
      passwordHash,
      fullName: input.fullName,
      isOwner: true,
    })
    .returning({ id: schema.users.id });

  const [ownerRole] = await ctx.db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.code, 'owner'))
    .limit(1);

  if (user && ownerRole) {
    await ctx.db.insert(schema.userRoles).values({
      tenantId: ctx.tenantId,
      userId: user.id,
      roleId: ownerRole.id,
      scopeType: 'tenant',
      scopeId: null,
    });
  }
  return user!.id;
}
