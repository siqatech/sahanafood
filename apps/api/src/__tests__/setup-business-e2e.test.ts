import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { OrganizationService } from '../modules/organization/index.js';
import { OrganizationAdminService } from '../modules/organization/index.js';
import {
  CatalogService,
  CatalogAdminService,
} from '../modules/catalog/index.js';
import { StorefrontService } from '../modules/storefront/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import {
  aplicarNegocio,
  aUnidadesMenores,
  type DescripcionNegocio,
} from '../database/business-setup.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Configuración de un negocio por archivo (docs/34 §5).
 *
 * Esta suite existe porque el runbook **ya prometía este comando y este
 * ejemplo** cuando ninguno de los dos existía. Lo que se comprueba aquí no es
 * que el guion corra: es que `infra/ejemplos/negocio.ejemplo.json` —el archivo
 * que alguien va a copiar el día del despliegue— se aplique de verdad y deje un
 * negocio que vende.
 *
 * Un ejemplo que nadie ha ejecutado se descubre roto con el cliente delante.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const EJEMPLO = fileURLToPath(
  new URL('../../../../infra/ejemplos/negocio.ejemplo.json', import.meta.url),
);

suite('Configuración del negocio desde archivo', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];
  let tenantId = '';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();

    await seedPlans(pool);
    const alta = await app.get(TenancyService).provisionTenant({
      name: 'Negocio por archivo',
      planCode: 'growth',
      owner: {
        email: 'archivo@sahana.test',
        password: 'password-archivo-1',
        fullName: 'Dueña del archivo',
      },
    });
    tenantId = alta.tenantId;
    created.push(tenantId);
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const servicios = (): {
    org: OrganizationAdminService;
    carta: CatalogAdminService;
    tienda: StorefrontService;
  } => ({
    org: app.get(OrganizationAdminService),
    carta: app.get(CatalogAdminService),
    tienda: app.get(StorefrontService),
  });

  const leerEjemplo = (): DescripcionNegocio =>
    JSON.parse(readFileSync(EJEMPLO, 'utf8')) as DescripcionNegocio;

  it('EL EJEMPLO DEL RUNBOOK se aplica y deja un negocio que vende', async () => {
    const negocio = leerEjemplo();
    const resumen = await aplicarNegocio(servicios(), tenantId, negocio);

    expect(resumen.brandCount).toBe(1);
    expect(resumen.productCount).toBe(4);

    // ---- La tienda resuelve por el host declarado en el archivo.
    const tienda = app.get(StorefrontService);
    const contexto = await tienda.resolveHost('buensabor.sahana.food');
    expect(contexto.brandName).toBe('Pollería El Buen Sabor');

    // ---- La carta que ve un cliente es la del archivo, con precio de canal.
    const catalogo = app.get(CatalogService);
    const carta = await catalogo.getResolvedCatalog(tenantId, {
      brandId: contexto.brandId,
      channel: 'web',
    });
    const pollo = carta.products.find((p) => p.name.includes('entero'));
    expect(pollo).toBeDefined();
    // 59.00 en la web, no los 55.00 de base: si saliera el base, la carta por
    // canal sería decorativa y el negocio perdería el margen que la justifica.
    expect(pollo!.price.minorUnits).toBe(590_000);
    expect(pollo!.modifierGroups.map((g) => g.name)).toEqual([
      'Guarnición',
      'Cremas extra',
    ]);

    // ---- Hay cobertura donde el archivo dice, y con su tarifa.
    const org = app.get(OrganizationService);
    const cobertura = await org.findCoverage(
      tenantId,
      [-77.02, -12.125],
      contexto.brandId,
    );
    expect(cobertura).toBeTruthy();
    expect(cobertura!.deliveryFee.minorUnits).toBe(50_000); // S/ 5.00

    // ---- Y un pedido entra y se cobra al precio del archivo.
    const ensalada = pollo!.modifierGroups[0]!.options.find(
      (o) => o.name === 'Ensalada',
    )!;
    const pedido = await app.get(OrderingService).submit(tenantId, {
      brandId: contexto.brandId,
      locationId: cobertura!.locationId,
      channel: 'web',
      lines: [
        {
          productId: pollo!.id,
          quantity: 1,
          modifierOptionIds: [ensalada.id],
        },
      ],
    });
    expect(pedido.total.minorUnits).toBe(620_000); // 59.00 + 3.00
  });

  it('VOLVER A APLICARLO con la carta cambiada corrige el precio', async () => {
    // El caso real del runbook: se detecta un precio mal escrito y se vuelve a
    // aplicar el mismo archivo. Si duplicara la marca o el producto, el negocio
    // acabaría con dos cartas y ningún modo de saber cuál cobra la caja.
    const negocio = leerEjemplo();
    negocio.carta![0]!.productos[0]!.precios['web'] = '62.50';

    await aplicarNegocio(servicios(), tenantId, negocio);

    const tienda = app.get(StorefrontService);
    const contexto = await tienda.resolveHost('buensabor.sahana.food');
    const carta = await app.get(CatalogService).getResolvedCatalog(tenantId, {
      brandId: contexto.brandId,
      channel: 'web',
    });
    const pollo = carta.products.find((p) => p.name.includes('entero'))!;
    expect(pollo.price.minorUnits).toBe(625_000);

    // Y sigue habiendo UNA marca, UN local y CUATRO productos.
    const estructura = await app
      .get(OrganizationService)
      .getStructure(tenantId);
    expect(estructura.brands).toHaveLength(1);
    expect(estructura.locations).toHaveLength(1);
    expect(carta.products).toHaveLength(4);
  });

  it('un importe con coma flotante disfrazada se rechaza al leerlo', async () => {
    // Los importes van como cadena en soles y se convierten a unidades menores
    // con aritmética entera. Aceptar "12.5000000001" o un número suelto sería
    // meter coma flotante justo en la cifra que no la admite.
    expect(aUnidadesMenores('12.50', 'x')).toBe(125_000);
    expect(aUnidadesMenores('12', 'x')).toBe(120_000);
    expect(aUnidadesMenores('-2.00', 'x')).toBe(-20_000);
    expect(() => aUnidadesMenores('12.50001', 'precio de prueba')).toThrow(
      /no es un importe válido/,
    );
    expect(() => aUnidadesMenores('S/ 12.50', 'precio de prueba')).toThrow(
      /no es un importe válido/,
    );
  });

  it('un día de la semana imposible se rechaza en vez de guardar un horario muerto', async () => {
    // weekday 7 —lunes contado desde 1— guardaría un tramo que el evaluador
    // nunca casa: el local aparecería cerrado y nada habría fallado.
    const negocio = leerEjemplo();
    negocio.locales[0]!.horarios![0]!.semanal[0]!.weekday = 7;
    await expect(
      aplicarNegocio(servicios(), tenantId, negocio),
    ).rejects.toThrow(/weekday 7 no existe/);
  });

  it('una marca que la carta nombra pero el archivo no declara se rechaza', async () => {
    const negocio = leerEjemplo();
    negocio.carta![0]!.marca = 'Marca Fantasma';
    await expect(
      aplicarNegocio(servicios(), tenantId, negocio),
    ).rejects.toThrow(/"Marca Fantasma" no está en la lista de marcas/);
  });
});
