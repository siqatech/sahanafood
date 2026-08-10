import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { OrganizationAdminService } from '../modules/organization/index.js';
import { CatalogAdminService } from '../modules/catalog/index.js';
import { StorefrontService } from '../modules/storefront/index.js';
import { InventoryAdminService } from '../modules/inventory/index.js';
import { aplicarNegocio, type DescripcionNegocio } from './business-setup.js';

/**
 * Configuración de un negocio **desde un archivo**, de una vez.
 *
 *   node dist/database/setup-business.js --tenant <TENANT_ID> --file negocio.json
 *
 * Esto es solo el envoltorio: lee argumentos, abre el contexto de Nest y
 * escribe el resultado. Lo que aplica la configuración vive en
 * `business-setup.ts`, separado justamente para que una prueba pueda ejecutarlo
 * contra `infra/ejemplos/negocio.ejemplo.json` — un runbook que promete un
 * comando y un ejemplo que nadie ha corrido es cómo se llega al día del
 * despliegue con un archivo que no aplica.
 *
 * Lo que NO hace: crear el tenant (eso es `provision.js`) ni comprobar el DNS
 * de verdad. Da el dominio por verificado porque quien ejecuta esto tiene
 * acceso al servidor; la comprobación real del CNAME llega con T3.16.
 */

interface Opciones {
  tenant: string;
  file: string;
}

function leerArgumentos(argv: string[]): Opciones {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const clave = argv[i];
    const valor = argv[i + 1];
    if (clave?.startsWith('--') && valor !== undefined) {
      args.set(clave.slice(2), valor);
    }
  }
  const tenant = args.get('tenant')?.trim() ?? '';
  const file = args.get('file')?.trim() ?? '';
  if (!tenant || !file) {
    throw new Error(
      'Uso:\n' +
        '  node dist/database/setup-business.js --tenant <TENANT_ID> --file negocio.json\n\n' +
        'El TENANT_ID lo devuelve `provision.js`. Hay un ejemplo comentado en\n' +
        'infra/ejemplos/negocio.ejemplo.json.',
    );
  }
  return { tenant, file };
}

async function main(): Promise<void> {
  const opciones = leerArgumentos(process.argv.slice(2));
  const negocio = JSON.parse(
    readFileSync(opciones.file, 'utf8'),
  ) as DescripcionNegocio;

  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ['error', 'warn'],
  });

  try {
    const resumen = await aplicarNegocio(
      {
        org: app.get(OrganizationAdminService),
        carta: app.get(CatalogAdminService),
        tienda: app.get(StorefrontService),
        inventario: app.get(InventoryAdminService),
      },
      opciones.tenant,
      negocio,
      // El progreso va a stderr: es para quien mira. Lo que va a stdout es el
      // JSON del final, que sí se puede encadenar con otro comando.
      (texto) => console.error(`  ${texto}`),
    );

    process.stdout.write(
      `${JSON.stringify({ tenantId: opciones.tenant, ...resumen }, null, 2)}\n`,
    );
    console.error(
      '\nListo. Vuelve a aplicar este mismo archivo cuando cambie la carta:\n' +
        'actualiza precios y añade productos nuevos sin duplicar nada.',
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
