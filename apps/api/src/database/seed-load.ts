import 'reflect-metadata';
import type { Pool } from 'pg';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PG_POOL } from './database.module.js';
import { withTenant } from './rls.js';
import { seedPlans } from './seed.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import { TenancyService } from '../modules/tenancy/index.js';
import {
  ConnectionService,
  SIMULATOR_PROVIDER,
} from '../modules/integrations/index.js';

/**
 * Escenario de carga reproducible (T4.30).
 *
 * k6 no puede llamar a TypeScript: necesita un tenant que ya exista, con
 * catálogo publicado y un usuario con el que autenticarse. Este script lo deja
 * montado y **escribe los ids en stdout como JSON**, que es lo que el guion de
 * k6 lee para no tener que adivinarlos.
 *
 * Es IDEMPOTENTE: volver a ejecutarlo reutiliza el tenant si ya está. Una
 * prueba de carga se repite muchas veces —cambiando un índice, subiendo el
 * pool— y crear un tenant nuevo en cada vuelta llenaría la base de datos
 * basura y haría que los números de dos ejecuciones no se pudieran comparar.
 */

const EMAIL = 'carga@sahana.test';
const PASSWORD = 'password-de-carga-1';
const NOMBRE_TENANT = 'Carga — Escenario k6';

/**
 * Secreto de firma del webhook de carga.
 *
 * Fijo a propósito: k6 tiene que firmar con él y el guion no puede leer la
 * base. No es una credencial real —el proveedor es el simulador, no Rappi— y
 * vive en un tenant llamado «Carga» que no debería existir en producción.
 */
const SECRETO_WEBHOOK = 'secreto-de-carga-para-firmar';
const CANAL_MARKETPLACE = 'marketplace';
/** SKU externo que el guion de ingesta manda en cada pedido. */
const SKU_EXTERNO = 'CARGA-POLLO';
/**
 * SKU externo de la opción obligatoria.
 *
 * El producto tiene un grupo de modificadores con mínimo 1 («Tamaño»), así que
 * un pedido sin él se rechaza —correctamente— con «Debes elegir en "Tamaño"».
 * Mapear solo el producto dejaba la ingesta fallando el 100 % de las veces, y
 * el fallo parecía de la integración cuando era del payload.
 */
const SKU_OPCION = 'CARGA-TAMANO';

export interface LoadScenario {
  tenantId: string;
  brandId: string;
  locationId: string;
  productId: string;
  modifierOptionId: string;
  email: string;
  password: string;
  /** Token público de la URL del webhook. Lo usa `ingest-webhooks.js`. */
  webhookToken: string;
  signingSecret: string;
  externalSku: string;
  externalOptionSku: string;
  reused: boolean;
}

/**
 * Deja lista la conexión de marketplace por la que entra `ingest-webhooks.js`.
 *
 * Idempotente igual que el resto: si ya hay una conexión del simulador para
 * esa marca y local, se reutiliza su token. Crear otra fallaría —hay UNIQUE
 * (tenant, provider, brand, location)— y además cambiaría el token en cada
 * siembra, con lo que el guion de k6 dejaría de servir de una vuelta a otra.
 */
async function asegurarConexion(
  pool: Pool,
  connections: ConnectionService,
  tenantId: string,
  destino: {
    brandId: string;
    locationId: string;
    productId: string;
    modifierOptionId: string;
  },
): Promise<string> {
  const existente = await withTenant(pool, tenantId, async ({ client }) => {
    const { rows } = await client.query<{ id: string; webhook_token: string }>(
      `SELECT id, webhook_token FROM int_connections
        WHERE provider = $1 AND brand_id = $2 AND location_id = $3`,
      [SIMULATOR_PROVIDER, destino.brandId, destino.locationId],
    );
    return rows[0];
  });

  if (existente) {
    // El secreto está CIFRADO con una clave derivada de CREDENTIALS_MASTER_KEY.
    // Si la siembra anterior corrió con otra clave —lo normal: el que siembra a
    // mano se olvida de la variable y el que arranca la API no— el token sigue
    // resolviendo pero el descifrado revienta, y el webhook devuelve 500 sin
    // decir por qué. Comprobarlo aquí cuesta una consulta; no comprobarlo costó
    // una corrida entera de carga con 334 fallos idénticos.
    const legible = await connections
      .resolveByWebhookToken(existente.webhook_token)
      .then((c) => c?.signingSecret === SECRETO_WEBHOOK)
      .catch(() => false);
    if (legible) {
      // El mapeo se reasegura SIEMPRE, no solo al crear: una conexión sembrada
      // por una versión anterior de este guion puede tener el producto mapeado
      // y la opción no. `mapSku` no duplica (ON CONFLICT DO NOTHING).
      await mapearSkus(connections, tenantId, existente.id, destino);
      return existente.webhook_token;
    }

    process.stderr.write(
      'La conexión de carga se cifró con otra CREDENTIALS_MASTER_KEY; se recrea.\n',
    );
    await withTenant(pool, tenantId, ({ client }) =>
      client.query('DELETE FROM int_connections WHERE id = $1', [existente.id]),
    );
  }

  const conexion = await connections.create(tenantId, {
    provider: SIMULATOR_PROVIDER,
    channel: CANAL_MARKETPLACE,
    brandId: destino.brandId,
    locationId: destino.locationId,
    signingSecret: SECRETO_WEBHOOK,
  });

  await mapearSkus(connections, tenantId, conexion.id, destino);

  return conexion.webhookToken;
}

/**
 * Mapea el SKU del producto y el de la opción obligatoria.
 *
 * Sin mapeo, cada pedido acabaría en la bandeja de excepciones por SKU
 * desconocido (RN-INT-02). Eso NO es pérdida —el payload queda guardado— pero
 * mediría el camino del error, que es más corto, y el percentil saldría
 * engañosamente bueno.
 */
async function mapearSkus(
  connections: ConnectionService,
  tenantId: string,
  connectionId: string,
  destino: { productId: string; modifierOptionId: string },
): Promise<void> {
  await connections.mapSku(tenantId, {
    connectionId,
    externalSku: SKU_EXTERNO,
    productId: destino.productId,
  });
  await connections.mapSku(tenantId, {
    connectionId,
    externalSku: SKU_OPCION,
    modifierOptionId: destino.modifierOptionId,
  });
}

export async function seedLoadScenario(
  pool: Pool,
  tenancy: TenancyService,
  connections: ConnectionService,
): Promise<LoadScenario> {
  await seedPlans(pool);

  const { rows: existente } = await pool.query<{ id: string }>(
    `SELECT id FROM ten_tenants WHERE name = $1`,
    [NOMBRE_TENANT],
  );

  // Un tenant a medias —de una siembra que falló después de crearlo— se
  // COMPLETA, no se duplica. Crear otro con el mismo correo deja el login
  // ambiguo y devuelve 403 sin explicar por qué (PA-01): un fallo que cuesta
  // media hora entender y que aquí es evitable.
  const tenantExistente = existente[0]?.id ?? null;

  if (tenantExistente) {
    const tenantId = tenantExistente;
    const datos = await withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        brand_id: string;
        location_id: string;
        product_id: string;
        option_id: string;
      }>(
        `SELECT b.id AS brand_id, l.id AS location_id,
                p.id AS product_id, o.id AS option_id
           FROM org_brands b
           JOIN org_locations l ON l.tenant_id = b.tenant_id
           JOIN cat_products p ON p.brand_id = b.id
           JOIN cat_product_modifier_groups pg ON pg.product_id = p.id
           JOIN cat_modifier_options o ON o.group_id = pg.group_id
          ORDER BY p.created_at
          LIMIT 1`,
      );
      return rows[0];
    });

    if (datos) {
      const webhookToken = await asegurarConexion(pool, connections, tenantId, {
        brandId: datos.brand_id,
        locationId: datos.location_id,
        productId: datos.product_id,
        modifierOptionId: datos.option_id,
      });
      return {
        tenantId,
        brandId: datos.brand_id,
        locationId: datos.location_id,
        productId: datos.product_id,
        modifierOptionId: datos.option_id,
        email: EMAIL,
        password: PASSWORD,
        webhookToken,
        signingSecret: SECRETO_WEBHOOK,
        externalSku: SKU_EXTERNO,
        externalOptionSku: SKU_OPCION,
        reused: true,
      };
    }
  }

  // Se da de alta por el camino REAL de producción: el mismo que usa un
  // cliente nuevo. Reimplementar el alta aquí mediría un escenario que no se
  // parece al que va a estar en producción —otro hash de contraseña, otros
  // roles— y la prueba de carga dejaría de decir nada útil.
  const tenantId =
    tenantExistente ??
    (
      await tenancy.provisionTenant({
        name: NOMBRE_TENANT,
        planCode: 'scale',
        owner: {
          email: EMAIL,
          password: PASSWORD,
          fullName: 'Generador de carga',
        },
      })
    ).tenantId;

  const escenario = await withTenant(pool, tenantId, async (ctx) => {
    const org = await seedDemoOrganization(ctx);
    const cat = await seedDemoCatalog(ctx, {
      brandId: org.brandIds[0]!,
      locationId: org.locationId,
    });

    // Política de aceptación automática: la prueba mide el camino de ALTA de
    // pedidos, no la velocidad con la que alguien pulsa «aceptar». Sin esto,
    // todos los pedidos se quedarían en `received` y el outbox no se llenaría
    // — que es justo lo que la prueba de cero pérdida tiene que ejercitar.
    await ctx.client.query(
      `INSERT INTO ord_acceptance_policies
         (tenant_id, brand_id, channel, auto_accept)
       VALUES ($1, $2, NULL, true)`,
      [tenantId, org.brandIds[0]],
    );

    return {
      brandId: org.brandIds[0]!,
      locationId: org.locationId,
      productId: cat.polloId,
      modifierOptionId: cat.optionGrandeId,
    };
  });

  const webhookToken = await asegurarConexion(pool, connections, tenantId, {
    brandId: escenario.brandId,
    locationId: escenario.locationId,
    productId: escenario.productId,
    modifierOptionId: escenario.modifierOptionId,
  });

  return {
    tenantId,
    ...escenario,
    email: EMAIL,
    password: PASSWORD,
    webhookToken,
    signingSecret: SECRETO_WEBHOOK,
    externalSku: SKU_EXTERNO,
    externalOptionSku: SKU_OPCION,
    reused: false,
  };
}

if (process.argv[1]?.endsWith('seed-load.ts')) {
  // `abortOnError: false` es obligatorio aquí. Con el valor por defecto, un
  // fallo al construir el contexto —falta DATABASE_URL, por ejemplo— hace que
  // Nest lo registre y llame a `process.exit(1)` por su cuenta; con
  // `logger: false` ese registro no sale por ningún lado y el guion muere con
  // código 1 y CERO salida. Así el error llega al `catch` de abajo y se ve.
  NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  })
    .then(async (app) => {
      const escenario = await seedLoadScenario(
        app.get<Pool>(PG_POOL),
        app.get(TenancyService),
        app.get(ConnectionService),
      );
      // JSON puro en stdout: es lo que lee el guion de k6. Se escribe con
      // `process.stdout` y no con `console.log` porque aquí stdout no es un
      // log —es la salida del programa— y nada más puede colarse por ahí.
      process.stdout.write(`${JSON.stringify(escenario, null, 2)}\n`);
      await app.close();
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
