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
import {
  InventoryAdminService,
  InventoryService,
} from '../modules/inventory/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import {
  aplicarNegocio,
  aUnidadesMenores,
  type DescripcionNegocio,
} from '../database/business-setup.js';
import { importar } from '../database/import-csv.js';
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

const ejemplo = (nombre: string): string =>
  fileURLToPath(
    new URL(`../../../../infra/ejemplos/${nombre}`, import.meta.url),
  );

const EJEMPLO = ejemplo('negocio.ejemplo.json');
const HOJA_CARTA = ejemplo('carta.ejemplo.csv');
const HOJA_INSUMOS = ejemplo('insumos.ejemplo.csv');
const HOJA_RECETAS = ejemplo('recetas.ejemplo.csv');

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
    inventario: InventoryAdminService;
  } => ({
    org: app.get(OrganizationAdminService),
    carta: app.get(CatalogAdminService),
    tienda: app.get(StorefrontService),
    inventario: app.get(InventoryAdminService),
  });

  const leerEjemplo = (): DescripcionNegocio =>
    JSON.parse(readFileSync(EJEMPLO, 'utf8')) as DescripcionNegocio;

  it('EL EJEMPLO DEL RUNBOOK se aplica y deja un negocio que vende', async () => {
    const negocio = leerEjemplo();
    const resumen = await aplicarNegocio(servicios(), tenantId, negocio);

    expect(resumen.brandCount).toBe(1);
    expect(resumen.productCount).toBe(4);
    // Y el negocio no solo vende: DESCUENTA. Sin la sección de inventario, el
    // consumo automático no se dispara nunca y el food cost de un cliente
    // nuevo se queda en cero — vendiendo con normalidad, eso sí, que es lo que
    // hace el fallo difícil de ver.
    expect(resumen.itemCount).toBe(5);
    expect(resumen.recipeCount).toBe(4);

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

    // ---- Y AL ACEPTARLO, la cocina descuenta de verdad.
    //
    // Es la comprobación que da sentido a la sección de inventario del
    // archivo: sin receta el pedido entra igual, se cobra igual y NO descuenta
    // nada. El fallo no se ve —el negocio funciona— hasta que alguien pregunta
    // por el food cost tres meses después y es cero.
    await app
      .get(OrderingService)
      .applyTransition(tenantId, pedido.id, 'accept', { actorType: 'system' });
    const consumo = await app
      .get(InventoryService)
      .consumeForOrder(tenantId, pedido.id);
    expect(consumo.movements).toBeGreaterThan(0);
    // Y ningún producto se vendió sin costear: si la sección de inventario del
    // archivo se quedara corta, aquí aparecería el nombre del plato huérfano.
    expect(consumo.productsWithoutRecipe).toEqual([]);

    // 1200 g de pollo + 5 % de merma = 1260 g. El pollo entero de la receta.
    const kardex = await app.get(InventoryService).kardex(tenantId, {});
    const pollos = kardex.filter((m) => m.itemName === 'Pollo crudo');
    expect(pollos).toHaveLength(1);
    expect(Number(pollos[0]!.quantity)).toBeCloseTo(-1260, 4);
    // Y la subreceta estalló: la crema son mayonesa y ketchup, no una línea.
    expect(kardex.some((m) => m.itemName === 'Mayonesa')).toBe(true);
    expect(kardex.some((m) => m.itemName === 'Ketchup')).toBe(true);
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

  it('LA CARTA IMPORTADA DESDE CSV se aplica igual, y cobra lo mismo', async () => {
    // El camino del Excel termina aquí: hoja → `import-csv` → este mismo
    // `aplicarNegocio`. Se comprueba contra Postgres de verdad y no solo con
    // una comparación de objetos porque lo que hay que demostrar es que **se
    // puede vender** con lo que salió de la hoja: que el precio que cobra es el
    // de la columna y que el kardex descuenta lo que dice la receta.
    //
    // Es también lo que mantiene vivas las hojas de `infra/ejemplos/`: un
    // ejemplo que nadie ha ejecutado se descubre roto con el cliente delante.
    const base = leerEjemplo();
    const importado = importar({
      // Se parte del negocio SIN carta ni inventario, que es la situación real
      // de quien los tiene en una hoja de cálculo.
      negocio: {
        ...base,
        carta: [
          {
            marca: base.marcas[0]!.nombre,
            gruposModificadores: base.carta![0]!.gruposModificadores!,
            productos: [],
          },
        ],
        ...(base.inventario ? { inventario: undefined } : {}),
      } as DescripcionNegocio,
      productosCsv: readFileSync(HOJA_CARTA, 'utf8'),
      insumosCsv: readFileSync(HOJA_INSUMOS, 'utf8'),
      recetasCsv: readFileSync(HOJA_RECETAS, 'utf8'),
    });

    const resumen = await aplicarNegocio(
      servicios(),
      tenantId,
      importado.negocio,
    );
    expect(resumen.productCount).toBe(4);
    expect(resumen.itemCount).toBe(5);
    expect(resumen.recipeCount).toBe(4);

    // El precio que cobra es el de la columna `precio_web` —escrita «59,00»,
    // con coma decimal, como la exporta un Excel en español—.
    const tienda = app.get(StorefrontService);
    const contexto = await tienda.resolveHost('buensabor.sahana.food');
    const carta = await app.get(CatalogService).getResolvedCatalog(tenantId, {
      brandId: contexto.brandId,
      channel: 'web',
    });
    const pollo = carta.products.find((p) => p.name.includes('entero'));
    expect(pollo).toBeDefined();
    expect(pollo!.price.minorUnits).toBe(
      aUnidadesMenores('59.00', 'precio_web del CSV'),
    );
    // Y el combo llegó como combo: la celda «POLLO-ENT x1 | GASEOSA-15 x1» es
    // la única forma que tiene una hoja de cálculo de decir esto, y leerla mal
    // publicaría un combo vacío que se puede pedir.
    const productos = await app
      .get(CatalogAdminService)
      .listProducts(tenantId, { brandId: contexto.brandId });
    const combo = productos.find((p) => p.name === 'Combo familiar');
    expect(combo?.isCombo).toBe(true);
  });
});
