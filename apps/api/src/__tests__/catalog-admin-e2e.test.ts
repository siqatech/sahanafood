import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { CatalogService } from '../modules/catalog/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Alta y edición de la carta (spec 04 «CRUD completo», salda DT-10).
 *
 * Esta suite existe porque el sistema **no tenía forma de crear un producto**.
 * De la spec 04 solo se había construido la lectura —resolución de precio,
 * pausa, publicación versionada— y la única escritura era la semilla demo, que
 * siempre monta la misma pollería ficticia con SQL directo.
 *
 * Lo que se comprueba no es que las filas se inserten: es que **lo creado por
 * la API sea exactamente lo que la tienda muestra y lo que la caja cobra**. Una
 * tabla paralela que parece bien no sirve de nada; el precio que el dueño
 * escribe tiene que ser el que acaba en el total del pedido.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Alta de la carta', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let tenantB = '';
  let tokenB = '';

  /** Estructura mínima de A, creada por la misma API de organización. */
  let marcaA = '';
  let localA = '';
  /** Una marca de B, para las pruebas de aislamiento. */
  let marcaB = '';

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
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'Carta Tenant A',
      planCode: 'growth',
      owner: {
        email: 'carta-a@sahana.test',
        password: 'password-carta-a-1',
        fullName: 'Dueña Carta A',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    const b = await tenancy.provisionTenant({
      name: 'Carta Tenant B',
      planCode: 'growth',
      owner: {
        email: 'carta-b@sahana.test',
        password: 'password-carta-b-1',
        fullName: 'Dueño Carta B',
      },
    });
    tenantB = b.tenantId;
    created.push(tenantB);

    tokenA = await entrar('carta-a@sahana.test', 'password-carta-a-1');
    tokenB = await entrar('carta-b@sahana.test', 'password-carta-b-1');

    const estructura = await montarNegocio(tokenA, '20512345601', 'La Carta');
    marcaA = estructura.brandId;
    localA = estructura.locationId;
    marcaB = (await montarNegocio(tokenB, '20512345602', 'Otra Carta')).brandId;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  async function entrar(email: string, password: string): Promise<string> {
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    return r.body.accessToken as string;
  }

  const como = (token: string) => (r: request.Test) =>
    r.set('authorization', `Bearer ${token}`);
  const http = () => request(app.getHttpServer());

  /** Estructura mínima para que un pedido pueda cocinarse en algún sitio. */
  async function montarNegocio(
    token: string,
    ruc: string,
    nombre: string,
  ): Promise<{ brandId: string; locationId: string }> {
    const a = como(token);
    const empresa = await a(http().post('/api/v1/org/companies'))
      .send({ legalName: `${nombre} S.A.C.`, taxId: ruc })
      .expect(201);
    const marca = await a(http().post('/api/v1/org/brands'))
      .send({ companyId: empresa.body.id, name: nombre })
      .expect(201);
    const local = await a(http().post('/api/v1/org/locations'))
      .send({
        companyId: empresa.body.id,
        name: `Local ${nombre}`,
        address: 'Av. Larco 100',
        lat: -12.125,
        lng: -77.02,
      })
      .expect(201);
    const cocina = await a(http().post('/api/v1/org/kitchens'))
      .send({ locationId: local.body.id, name: 'Cocina principal' })
      .expect(201);
    await a(http().post('/api/v1/org/brand-kitchens'))
      .send({ brandId: marca.body.id, kitchenId: cocina.body.id })
      .expect(201);
    return { brandId: marca.body.id, locationId: local.body.id };
  }

  it('UNA CARTA COMPLETA desde cero, y es la que se cobra', async () => {
    const a = como(tokenA);

    const categoria = await a(http().post('/api/v1/catalog/categories'))
      .send({ brandId: marcaA, name: 'Pollos', sortOrder: 1 })
      .expect(201);

    const pollo = await a(http().post('/api/v1/catalog/products'))
      .send({
        brandId: marcaA,
        categoryId: categoria.body.id,
        sku: 'POLLO-ENT',
        name: 'Pollo a la brasa entero',
        description: 'Con papas y ensalada',
        allergens: ['gluten'],
        prepMinutes: 25,
      })
      .expect(201);
    expect(pollo.body.rowVersion).toBe(1);

    // Precio base (cualquier canal) y precio propio de la web: la diferencia
    // por canal es la palanca de rentabilidad del negocio, no un adorno.
    await a(http().post('/api/v1/catalog/prices'))
      .send({ productId: pollo.body.id, priceMinor: 550_000 }) // S/ 55.0000
      .expect(201);
    const precioWeb = await a(http().post('/api/v1/catalog/prices'))
      .send({
        productId: pollo.body.id,
        channel: 'web',
        priceMinor: 590_000, // S/ 59.0000
      })
      .expect(201);
    expect(precioWeb.body.price).toBe('59.0000');
    // La marca del precio se DERIVA del producto: si se aceptara del cuerpo,
    // un precio podría apuntar a otra marca y desaparecer de los dos catálogos.
    expect(precioWeb.body.brandId).toBe(marcaA);

    const grupo = await a(http().post('/api/v1/catalog/modifier-groups'))
      .send({
        brandId: marcaA,
        name: '¿Con qué guarnición?',
        minSelections: 1,
        maxSelections: 1,
      })
      .expect(201);

    await a(http().post('/api/v1/catalog/modifier-options'))
      .send({ groupId: grupo.body.id, name: 'Papas fritas' })
      .expect(201);
    const ensalada = await a(http().post('/api/v1/catalog/modifier-options'))
      .send({
        groupId: grupo.body.id,
        name: 'Ensalada',
        priceDeltaMinor: 30_000, // S/ 3.0000
      })
      .expect(201);
    // Delta NEGATIVO: «sin papas» descuenta. Por eso no lleva mínimo.
    const sinPapas = await a(http().post('/api/v1/catalog/modifier-options'))
      .send({
        groupId: grupo.body.id,
        name: 'Sin guarnición',
        priceDeltaMinor: -20_000, // −S/ 2.0000
      })
      .expect(201);
    expect(sinPapas.body.priceDelta).toBe('-2.0000');

    await a(
      http().post(`/api/v1/catalog/products/${pollo.body.id}/modifier-groups`),
    )
      .send({ groupId: grupo.body.id })
      .expect(201);

    // ---- LA COMPROBACIÓN QUE IMPORTA (1): lo que la tienda muestra.
    const catalogo = app.get(CatalogService);
    const resuelto = await catalogo.getResolvedCatalog(tenantA, {
      brandId: marcaA,
      channel: 'web',
    });
    const enCarta = resuelto.products.find((p) => p.id === pollo.body.id);
    expect(enCarta).toBeDefined();
    // El precio del canal, no el base: 59 y no 55.
    expect(enCarta!.price.minorUnits).toBe(590_000);
    expect(enCarta!.prepMinutes).toBe(25);
    // La categoría del producto está entre las que se devuelven; si no, la
    // tienda lo pintaría bajo una sección que no existe.
    expect(resuelto.categories.map((c) => c.id)).toContain(categoria.body.id);
    expect(enCarta!.modifierGroups).toHaveLength(1);
    expect(enCarta!.modifierGroups[0]!.options.map((o) => o.name)).toContain(
      'Ensalada',
    );

    // ---- LA COMPROBACIÓN QUE IMPORTA (2): lo que la caja cobra.
    const ordering = app.get(OrderingService);
    const pedido = await ordering.submit(tenantA, {
      brandId: marcaA,
      locationId: localA,
      channel: 'web',
      lines: [
        {
          productId: pollo.body.id,
          quantity: 1,
          modifierOptionIds: [ensalada.body.id],
        },
      ],
    });
    // 59 del canal web + 3 de la ensalada. Si el total fuera 55 + 3, el
    // producto se estaría cobrando al precio base y la carta por canal sería
    // decorativa. El importe ya incluye IGV (RN-T05).
    expect(pedido.total.minorUnits).toBe(620_000);
  });

  it('el precio del CANAL manda sobre el base, y el del LOCAL sobre los dos', async () => {
    // RN-CAT-01 vista desde la escritura: los tres niveles se crean por API y
    // la resolución elige el más específico.
    const a = como(tokenA);
    const producto = await a(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'AMBITO-1', name: 'Producto de ámbito' })
      .expect(201);

    await a(http().post('/api/v1/catalog/prices'))
      .send({ productId: producto.body.id, priceMinor: 100_000 })
      .expect(201);
    await a(http().post('/api/v1/catalog/prices'))
      .send({
        productId: producto.body.id,
        channel: 'rappi',
        priceMinor: 130_000,
      })
      .expect(201);
    await a(http().post('/api/v1/catalog/prices'))
      .send({
        productId: producto.body.id,
        channel: 'rappi',
        locationId: localA,
        priceMinor: 145_000,
      })
      .expect(201);

    const catalogo = app.get(CatalogService);
    const base = await catalogo.resolveProductPrice(tenantA, producto.body.id, {
      channel: 'pos',
    });
    const canal = await catalogo.resolveProductPrice(
      tenantA,
      producto.body.id,
      { channel: 'rappi' },
    );
    const local = await catalogo.resolveProductPrice(
      tenantA,
      producto.body.id,
      { channel: 'rappi', locationId: localA },
    );
    expect(base?.minorUnits).toBe(100_000);
    expect(canal?.minorUnits).toBe(130_000);
    expect(local?.minorUnits).toBe(145_000);
  });

  it('VOLVER A APLICAR la misma carta corrige precios y no duplica nada', async () => {
    // Es el caso real: se detecta un precio mal escrito el viernes y se vuelve
    // a subir la hoja de cálculo. Una segunda pasada que duplicara productos
    // dejaría dos «Pollo a la brasa» a precios distintos en la misma carta.
    const a = como(tokenA);
    const datos = {
      brandId: marcaA,
      sku: 'REPETIDO-1',
      name: 'Producto repetido',
    };

    const uno = await a(http().post('/api/v1/catalog/products'))
      .send(datos)
      .expect(201);
    // El SKU manda sobre el nombre: renombrar no crea un producto nuevo, que
    // es lo que conserva el historial de ventas.
    const dos = await a(http().post('/api/v1/catalog/products'))
      .send({ ...datos, name: 'Producto repetido (grande)' })
      .expect(201);
    expect(dos.body.id).toBe(uno.body.id);
    expect(dos.body.name).toBe('Producto repetido (grande)');
    expect(dos.body.rowVersion).toBe(2);

    await a(http().post('/api/v1/catalog/prices'))
      .send({ productId: uno.body.id, channel: 'web', priceMinor: 200_000 })
      .expect(201);
    await a(http().post('/api/v1/catalog/prices'))
      .send({ productId: uno.body.id, channel: 'web', priceMinor: 210_000 })
      .expect(201);

    const cuantos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ p: string; pr: string }>(
        `SELECT
           (SELECT count(*) FROM cat_products WHERE sku = 'REPETIDO-1') AS p,
           (SELECT count(*) FROM cat_prices
             WHERE product_id = $1 AND channel = 'web') AS pr`,
        [uno.body.id],
      );
      return rows[0]!;
    });
    expect(Number(cuantos.p)).toBe(1);
    expect(Number(cuantos.pr)).toBe(1);

    const catalogo = app.get(CatalogService);
    const precio = await catalogo.resolveProductPrice(tenantA, uno.body.id, {
      channel: 'web',
    });
    expect(precio?.minorUnits).toBe(210_000);
  });

  it('If-Match desfasado devuelve 409 y no pisa el cambio del otro', async () => {
    // Dos supervisores corrigiendo el mismo plato a la vez: sin esto gana el
    // último en pulsar guardar y el otro no se entera.
    const a = como(tokenA);
    const p = await a(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'CONCURRENTE-1', name: 'Plato disputado' })
      .expect(201);

    // El primero guarda: la versión pasa a 2.
    await a(http().post('/api/v1/catalog/products'))
      .set('if-match', '1')
      .send({
        brandId: marcaA,
        sku: 'CONCURRENTE-1',
        name: 'Plato disputado v2',
      })
      .expect(201);

    // El segundo venía leyendo la 1 y llega tarde.
    const conflicto = await a(http().post('/api/v1/catalog/products'))
      .set('if-match', '1')
      .send({
        brandId: marcaA,
        sku: 'CONCURRENTE-1',
        name: 'Plato disputado v2 bis',
      })
      .expect(409);
    expect(conflicto.body.code).toBe('CATALOG_VERSION_CONFLICT');

    const catalogo = app.get(CatalogService);
    const resuelto = await catalogo.getResolvedCatalog(tenantA, {
      brandId: marcaA,
      channel: 'web',
    });
    // El nombre del primero sigue en pie: el segundo no lo pisó.
    const enBase = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ name: string }>(
        `SELECT name FROM cat_products WHERE sku = 'CONCURRENTE-1'`,
      );
      return rows[0]!.name;
    });
    expect(enBase).toBe('Plato disputado v2');
    // Sin precio no aparece en la carta: es lo correcto mientras se monta.
    expect(resuelto.products.map((x) => x.id)).not.toContain(p.body.id);
  });

  it('un COMBO lleva sus componentes y reemplaza la lista entera', async () => {
    const a = como(tokenA);
    const gaseosa = await a(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'GASEOSA-1', name: 'Gaseosa 500 ml' })
      .expect(201);
    const papas = await a(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'PAPAS-1', name: 'Papas fritas' })
      .expect(201);
    const combo = await a(http().post('/api/v1/catalog/products'))
      .send({
        brandId: marcaA,
        sku: 'COMBO-1',
        name: 'Combo personal',
        isCombo: true,
      })
      .expect(201);

    await a(http().post(`/api/v1/catalog/products/${combo.body.id}/combo`))
      .send({
        components: [
          { productId: gaseosa.body.id, quantity: 1 },
          { productId: papas.body.id, quantity: 2 },
        ],
      })
      .expect(201);

    // Se vuelve a aplicar sin las papas: la lista se reemplaza, no se acumula.
    await a(http().post(`/api/v1/catalog/products/${combo.body.id}/combo`))
      .send({ components: [{ productId: gaseosa.body.id, quantity: 1 }] })
      .expect(201);

    const componentes = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ component_id: string }>(
        'SELECT component_id FROM cat_combo_components WHERE combo_id = $1',
        [combo.body.id],
      );
      return rows.map((r) => r.component_id);
    });
    expect(componentes).toEqual([gaseosa.body.id]);

    // Un producto que no está marcado como combo no acepta componentes: si lo
    // aceptara, el inventario descontaría por una composición que la carta no
    // enseña.
    await a(http().post(`/api/v1/catalog/products/${papas.body.id}/combo`))
      .send({ components: [{ productId: gaseosa.body.id, quantity: 1 }] })
      .expect(422);
  });

  it('un grupo de OTRA MARCA no se puede unir a un producto', async () => {
    // Las claves foráneas del esquema son por (tenant, id): impiden cruzar
    // tenants pero NO cruzar marcas. Sin esta comprobación, un «¿con qué
    // gaseosa?» de la otra marca aparecería en el producto y el cliente
    // elegiría una bebida que esa cocina no tiene.
    const a = como(tokenA);
    const otra = await montarNegocio(tokenA, '20512345603', 'Segunda Marca');

    const producto = await a(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'CRUZADO-1', name: 'Producto marca uno' })
      .expect(201);
    const grupoAjeno = await a(http().post('/api/v1/catalog/modifier-groups'))
      .send({ brandId: otra.brandId, name: 'Grupo de la otra marca' })
      .expect(201);

    const r = await a(
      http().post(
        `/api/v1/catalog/products/${producto.body.id}/modifier-groups`,
      ),
    )
      .send({ groupId: grupoAjeno.body.id })
      .expect(422);
    expect(r.body.detail).toContain('otra marca');

    // Lo mismo con la categoría: un producto bajo una sección de otra marca
    // desaparecería de la carta sin que nada falle.
    const categoriaAjena = await a(http().post('/api/v1/catalog/categories'))
      .send({ brandId: otra.brandId, name: 'Sección ajena' })
      .expect(201);
    await a(http().post('/api/v1/catalog/products'))
      .send({
        brandId: marcaA,
        sku: 'CRUZADO-2',
        name: 'Producto con sección ajena',
        categoryId: categoriaAjena.body.id,
      })
      .expect(422);
  });

  it('un rango de selecciones imposible se rechaza con un motivo legible', async () => {
    const r = await como(tokenA)(http().post('/api/v1/catalog/modifier-groups'))
      .send({
        brandId: marcaA,
        name: 'Grupo imposible',
        minSelections: 3,
        maxSelections: 1,
      })
      .expect(422);
    // Y no «viola la restricción modifier_rango_coherente», que no le dice
    // nada a quien está subiendo su carta.
    expect(r.body.detail).toContain('menor que el mínimo');
  });

  it('EL LISTADO DEL PANEL enseña lo que la tienda oculta', async () => {
    // La diferencia con `getResolvedCatalog` es justo lo que hace falta aquí:
    // aquel omite a propósito el producto sin precio y el pausado, porque un
    // cliente no debe verlos. Un panel que usara esa vista no podría enseñar
    // el producto al que le falta el precio —el que hay que arreglar— ni el
    // pausado —el que hay que reactivar—.
    const a = como(tokenA);
    const otra = await montarNegocio(tokenA, '20512345604', 'Panel');

    await a(http().post('/api/v1/catalog/products'))
      .send({ brandId: otra.brandId, sku: 'SIN-PRECIO', name: 'A medio subir' })
      .expect(201);

    const pausado = await a(http().post('/api/v1/catalog/products'))
      .send({ brandId: otra.brandId, sku: 'PAUSADO', name: 'Sin pollo hoy' })
      .expect(201);
    await a(http().post('/api/v1/catalog/prices'))
      .send({ productId: pausado.body.id, channel: 'web', priceMinor: 400_000 })
      .expect(201);
    await a(http().post(`/api/v1/catalog/products/${pausado.body.id}/pause`))
      .send({ channels: ['web'], reason: 'Se acabó el pollo' })
      .expect(201);

    const catalogo = app.get(CatalogService);
    const tienda = await catalogo.getResolvedCatalog(tenantA, {
      brandId: otra.brandId,
      channel: 'web',
    });
    // La tienda no enseña ninguno de los dos. Eso está bien.
    expect(tienda.products).toHaveLength(0);

    // El panel enseña los dos, y dice por qué cada uno no se vende.
    const panel = await a(
      http().get(`/api/v1/catalog/products?brand=${otra.brandId}`),
    ).expect(200);
    const porSku = new Map<string, (typeof panel.body)[number]>(
      panel.body.map((p: { sku: string }) => [p.sku, p]),
    );
    expect(porSku.get('SIN-PRECIO')!.prices).toHaveLength(0);
    expect(porSku.get('PAUSADO')!.prices[0].price).toBe('40.0000');
    expect(porSku.get('PAUSADO')!.pauses[0].channel).toBe('web');
  });

  // ------------------------------------------------------ AISLAMIENTO

  it('AISLAMIENTO: B no puede colgar productos de la marca de A', async () => {
    // La comprobación obligatoria de todo endpoint nuevo. `brandId` va en el
    // cuerpo: si la consulta no filtrara por tenant, B metería platos en la
    // carta de A y los cobraría en su propia tienda.
    await como(tokenB)(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, name: 'Plato intruso' })
      .expect(404);

    await como(tokenB)(http().post('/api/v1/catalog/categories'))
      .send({ brandId: marcaA, name: 'Sección intrusa' })
      .expect(404);

    await como(tokenB)(http().post('/api/v1/catalog/modifier-groups'))
      .send({ brandId: marcaA, name: 'Grupo intruso' })
      .expect(404);

    const intrusos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM cat_products WHERE name = 'Plato intruso'`,
      );
      return Number(rows[0]!.n);
    });
    expect(intrusos).toBe(0);
  });

  it('AISLAMIENTO: B no puede ponerle precio a un producto de A', async () => {
    // El caso más caro de todos: cambiar el precio del competidor. El producto
    // se busca dentro del tenant, así que para B sencillamente no existe.
    const producto = await como(tokenA)(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'PRECIO-AISLADO', name: 'Plato de A' })
      .expect(201);
    await como(tokenA)(http().post('/api/v1/catalog/prices'))
      .send({ productId: producto.body.id, priceMinor: 300_000 })
      .expect(201);

    await como(tokenB)(http().post('/api/v1/catalog/prices'))
      .send({ productId: producto.body.id, priceMinor: 1 })
      .expect(404);

    const catalogo = app.get(CatalogService);
    const precio = await catalogo.resolveProductPrice(
      tenantA,
      producto.body.id,
      { channel: 'pos' },
    );
    expect(precio?.minorUnits).toBe(300_000);
  });

  it('AISLAMIENTO: dos tenants pueden usar el MISMO SKU', async () => {
    // La unicidad del SKU es por (tenant, marca). Si fuera global, el segundo
    // cliente que usara «POLLO-1» no podría subir su carta.
    const deA = await como(tokenA)(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'HOMONIMO-1', name: 'Homónimo de A' })
      .expect(201);
    const deB = await como(tokenB)(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaB, sku: 'HOMONIMO-1', name: 'Homónimo de B' })
      .expect(201);
    expect(deA.body.id).not.toBe(deB.body.id);
  });

  it('sin permiso de escritura no se crea nada', async () => {
    // 403 y no 401: el guardia responde lo mismo a «no traes token» y a «tu
    // token no alcanza», para no decirle a quien prueba qué permiso le falta.
    await http()
      .post('/api/v1/catalog/products')
      .send({ brandId: marcaA, name: 'Sin token' })
      .expect(403);
  });
});
