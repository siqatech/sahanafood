import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PG_POOL } from './database.module.js';
import type { Pool } from 'pg';
import { withTenant } from './rls.js';
import { seedPlans } from './seed.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import { StorefrontService } from '../modules/storefront/index.js';
import { OrderingService } from '../modules/ordering/index.js';

/**
 * Siembra una tienda demo para levantar `apps/web` a mano (T5.08–T5.14).
 *
 * Existe porque la tienda no se puede mirar sin una: sin dominio verificado, el
 * host no resuelve y todas las páginas dan 404 — que es exactamente lo que debe
 * pasar, y por eso hace falta este atajo para desarrollo.
 *
 *   pnpm --filter @sahana/api seed:shop
 *
 * El host por defecto es `demo.localhost`, que resuelve a 127.0.0.1 en los
 * navegadores modernos sin tocar `/etc/hosts`.
 */

const HOST = process.env['SHOP_HOST'] ?? 'demo.localhost';
const NOMBRE = 'Demo Tienda Web';

async function main(): Promise<void> {
  // `abortOnError: false`: con el valor por defecto, un fallo de arranque mata
  // el proceso sin imprimir nada y el script parece colgarse.
  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ['error', 'warn'],
  });

  const pool = app.get<Pool>(PG_POOL);
  await seedPlans(pool);

  // Se rehace desde cero en cada ejecución: un host es único globalmente, así
  // que dejar el anterior haría fallar la segunda pasada.
  await pool.query('DELETE FROM ten_tenants WHERE name = $1', [NOMBRE]);

  const tenant = await app.get(TenancyService).provisionTenant({
    name: NOMBRE,
    planCode: 'growth',
    owner: {
      email: 'demo-tienda@sahana.test',
      password: 'password-demo-tienda-1',
      fullName: 'Dueña de la tienda demo',
    },
  });

  const org = await withTenant(pool, tenant.tenantId, (ctx) =>
    seedDemoOrganization(ctx),
  );
  const brandId = org.brandIds[0]!;
  const catalogo = await withTenant(pool, tenant.tenantId, (ctx) =>
    seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
  );

  const storefront = app.get(StorefrontService);
  const dominio = await storefront.registerDomain(tenant.tenantId, {
    brandId,
    host: HOST,
  });
  await storefront.verifyDomain(tenant.tenantId, dominio.id);

  // Un cupón para poder probar el camino del descuento y el del mínimo.
  await withTenant(pool, tenant.tenantId, ({ client }) =>
    client.query(
      `INSERT INTO sto_coupons (tenant_id, brand_id, code, kind, percent_bps, min_order)
       VALUES ($1,$2,'BIENVENIDO','percent',1000,'50.0000')`,
      [tenant.tenantId, brandId],
    ),
  );

  // Dos pedidos APARTADOS en la bandeja de excepciones (RN-ORD-10). Sin ellos
  // la pantalla de excepciones solo se puede ver vacía, y una pantalla que solo
  // se puede mirar vacía no se puede desarrollar ni probar. Son dos porque el
  // flujo tiene dos salidas —resolver y rechazar— y cada una consume la suya.
  const ordering = app.get(OrderingService);
  for (const [ref, sku] of [
    ['DEMO-EXC-1', 'RAPPI-POLLO-XL'],
    ['DEMO-EXC-2', 'RAPPI-COMBO-2'],
  ] as const) {
    await ordering.submitForReview(tenant.tenantId, {
      brandId,
      locationId: org.locationId,
      channel: 'rappi',
      externalRef: ref,
      reason: `SKU externo sin mapear: ${sku}`,
      rawPayload: { order_id: ref, items: [{ sku, qty: 2 }] },
      customerName: 'Cliente de Rappi',
      customerPhone: '+51987000111',
    });
  }

  // Un pedido ESPERANDO ACEPTACIÓN, con su reloj corriendo. Sin él la torre de
  // control solo se puede mirar vacía, y una pantalla que solo se puede mirar
  // vacía no se puede desarrollar ni probar — que es exactamente cómo esta
  // pantalla acabó sin existir.
  await ordering.submit(tenant.tenantId, {
    brandId,
    locationId: org.locationId,
    channel: 'rappi',
    externalRef: 'DEMO-POR-ACEPTAR',
    lines: [{ productId: catalogo.comboId, quantity: 1 }],
    customerName: 'Cliente esperando',
  });

  console.log(
    JSON.stringify(
      {
        tenantId: tenant.tenantId,
        brandId,
        host: HOST,
        tienda: `http://${HOST}:3001/`,
        cupon: 'BIENVENIDO (10 %, mínimo S/ 50)',
        excepciones: `http://${HOST}:3001/panel/excepciones`,
        operaciones: `http://${HOST}:3001/panel/operaciones`,
      },
      null,
      2,
    ),
  );

  await app.close();
}

await main();
