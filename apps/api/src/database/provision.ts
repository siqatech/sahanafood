import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PG_POOL } from './database.module.js';
import type { Pool } from 'pg';
import { seedPlans } from './seed.js';
import { TenancyService } from '../modules/tenancy/index.js';

/**
 * Alta del PRIMER cliente en un despliegue nuevo.
 *
 * Existe porque faltaba. `provisionTenant` estaba escrito, probado y sin forma
 * de invocarlo desde fuera: no hay endpoint —y no debe haberlo, ver abajo— y
 * los guiones de semilla son TypeScript que la imagen de producción no lleva.
 * En un servidor recién levantado no había manera de crear un cliente: la
 * plataforma arrancaba sana y vacía, para siempre.
 *
 *   docker compose -f infra/docker/docker-compose.prod.yml run --rm api \
 *     node dist/database/provision.js \
 *       --nombre "Pollería El Buen Sabor" \
 *       --plan growth \
 *       --email duena@polleria.pe \
 *       --nombre-dueno "Rosa Quispe" \
 *       --password '...'
 *
 * **Por qué CLI y no endpoint.** Crear un tenant sin autenticar es una puerta
 * abierta: cualquiera daría de alta clientes, consumiría recursos y llenaría la
 * base. Y autenticarlo tampoco resuelve nada, porque en un despliegue nuevo no
 * existe todavía ningún usuario que pudiera tener ese permiso. Exigir acceso al
 * servidor es justo el nivel de autorización que corresponde a «dar de alta a
 * un cliente que paga». El día que haya alta de autoservicio será una decisión de
 * producto con su propio flujo —correo verificado, pago, límites— y no este
 * guion.
 */

interface Opciones {
  nombre: string;
  plan: string;
  email: string;
  nombreDueno: string;
  password: string;
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

  const faltan: string[] = [];
  const pedir = (clave: string): string => {
    const valor = args.get(clave)?.trim();
    if (!valor) faltan.push(`--${clave}`);
    return valor ?? '';
  };

  const opciones: Opciones = {
    nombre: pedir('nombre'),
    plan: args.get('plan')?.trim() || 'growth',
    email: pedir('email'),
    nombreDueno: pedir('nombre-dueno'),
    // La contraseña puede venir por entorno para que no quede en el historial
    // del shell ni en la lista de procesos de la máquina.
    password: (
      process.env['SAHANA_OWNER_PASSWORD'] ??
      args.get('password') ??
      ''
    ).trim(),
  };
  if (!opciones.password) faltan.push('--password (o SAHANA_OWNER_PASSWORD)');

  if (faltan.length > 0) {
    throw new Error(
      `Faltan argumentos: ${faltan.join(', ')}.\n\n` +
        'Uso:\n' +
        '  node dist/database/provision.js \\\n' +
        '    --nombre "Nombre del negocio" \\\n' +
        '    --email duena@negocio.pe \\\n' +
        '    --nombre-dueno "Nombre y apellido" \\\n' +
        '    --password "…"  (o SAHANA_OWNER_PASSWORD)\n' +
        '    [--plan starter|growth|scale]   (por defecto: growth)',
    );
  }
  return opciones;
}

async function main(): Promise<void> {
  const opciones = leerArgumentos(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ['error', 'warn'],
  });

  try {
    // Los planes son el catálogo de la plataforma, no datos de un cliente: en
    // una base recién migrada no existen, y sin ellos el alta falla con «Plan
    // no encontrado» sin decir que lo que falta es el arranque de la
    // plataforma. Es idempotente.
    await seedPlans(app.get<Pool>(PG_POOL));

    const resultado = await app.get(TenancyService).provisionTenant({
      name: opciones.nombre,
      planCode: opciones.plan,
      owner: {
        email: opciones.email,
        password: opciones.password,
        fullName: opciones.nombreDueno,
      },
    });

    // A stdout y como JSON: esto se encadena con otros comandos al automatizar
    // el alta, así que la salida limpia es el resultado. Se escribe con
    // `process.stdout` y no con `console.log` porque la regla de ESLint que
    // prohíbe `console` en el servidor tiene razón —los logs van por el logger
    // estructurado— y una excepción abriría la puerta a saltársela en un
    // controlador. Aquí no es un log: es el valor de retorno del comando.
    process.stdout.write(
      `${JSON.stringify(
        {
          tenantId: resultado.tenantId,
          ownerUserId: resultado.ownerUserId,
          plan: opciones.plan,
          email: opciones.email,
        },
        null,
        2,
      )}\n`,
    );
    console.error(
      `\nListo. Entra en el panel con ${opciones.email} y cambia la contraseña.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
