import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { AppModule } from '../app.module.js';
import { PG_POOL } from './database.module.js';
import { withTenant, withSystem } from './rls.js';
import { seedSystemRoles } from '../modules/identity/index.js';

/**
 * Reconciliación de los ROLES DEL SISTEMA en los tenants que ya existen.
 *
 * `seedSystemRoles` corre una sola vez, al provisionar el tenant. Eso significa
 * que **un permiso nuevo del catálogo no llega a nadie que ya fuera cliente**:
 * el código empieza a exigirlo el día del despliegue y ningún rol lo tiene.
 *
 * Lo que se ve entonces desde el local no es un error de permisos: es que el
 * supervisor deja de poder firmar el descuadre y la caja no cierra. Falla
 * cerrado, que es lo correcto, pero deja la operación parada hasta que alguien
 * relacione las dos cosas.
 *
 * Por eso este guion es **parte del despliegue**, no una utilidad de rescate.
 * Se ejecuta después de migrar y antes de dar por bueno el despliegue:
 *
 *   docker compose -f infra/docker/docker-compose.prod.yml run --rm api \
 *     node dist/database/sync-roles.js
 *
 * Es idempotente —`onConflictDoNothing` sobre (tenant, rol, permiso)— y **solo
 * añade**. No quita permisos que un tenant se haya dado por su cuenta: el
 * catálogo define el mínimo de cada rol del sistema, no su techo, y borrar lo
 * que no reconoce convertiría un despliegue rutinario en una retirada silenciosa
 * de accesos.
 */

export interface ResumenDeSincronizacion {
  tenants: number;
}

export async function syncSystemRoles(
  pool: Pool,
): Promise<ResumenDeSincronizacion> {
  // La lista de tenants es de la plataforma, no de ninguno de ellos: se lee con
  // el escape de sistema, igual que el relay del outbox.
  const ids = await withSystem(pool, async ({ client }) => {
    // También los suspendidos: un tenant suspendido vuelve, y volver con los
    // permisos a medias es peor que no haber vuelto.
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM ten_tenants ORDER BY created_at',
    );
    return rows.map((r) => r.id);
  });

  for (const tenantId of ids) {
    // Uno por transacción: si el tenant número cuarenta falla, los treinta y
    // nueve anteriores ya están sincronizados y el guion se puede repetir.
    await withTenant(pool, tenantId, async (ctx) => {
      await seedSystemRoles(ctx);
    });
  }

  return { tenants: ids.length };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ['error', 'warn'],
  });
  try {
    const resumen = await syncSystemRoles(app.get<Pool>(PG_POOL));
    // Salida limpia a stdout: es el valor de retorno del comando, no un log.
    process.stdout.write(`${JSON.stringify(resumen, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

// Solo cuando se invoca como comando: las pruebas importan `syncSystemRoles`.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}
