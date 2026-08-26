import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import {
  CatalogService,
  type AdminProductView,
  type ModifierGroupWithOptions,
} from '../modules/catalog/index.js';
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

  it('LOS GRUPOS DE MODIFICADORES SE PUEDEN LISTAR, que era lo que faltaba', async () => {
    // Se podían crear grupos y unirlos a un producto, pero para unir uno hay
    // que mandar su `id` y NINGUNA ruta los devolvía: el único sitio donde ese
    // `id` se podía leer era la base de datos. El módulo que hace que un pollo
    // se pueda pedir «con papas» solo se montaba por SQL.
    const a = como(tokenA);
    const grupo = await a(http().post('/api/v1/catalog/modifier-groups'))
      .send({
        brandId: marcaA,
        name: '¿Cómo lo quieres?',
        minSelections: 1,
        maxSelections: 2,
      })
      .expect(201);
    await a(http().post('/api/v1/catalog/modifier-options'))
      .send({ groupId: grupo.body.id, name: 'Bien cocido' })
      .expect(201);
    await a(http().post('/api/v1/catalog/modifier-options'))
      .send({
        groupId: grupo.body.id,
        name: 'Con ají extra',
        priceDeltaMinor: 15_000,
      })
      .expect(201);

    const listado = await a(
      http().get(`/api/v1/catalog/modifier-groups?brand=${marcaA}`),
    ).expect(200);

    const mio = (listado.body as ModifierGroupWithOptions[]).find(
      (g) => g.id === grupo.body.id,
    );
    expect(mio).toBeDefined();
    expect(mio!.minSelections).toBe(1);
    expect(mio!.maxSelections).toBe(2);
    // Con sus opciones: un grupo sin ellas no se puede ni revisar ni unir con
    // criterio, y son dos consultas que siempre se hacen juntas.
    expect(mio!.options.map((o) => o.name).sort()).toEqual([
      'Bien cocido',
      'Con ají extra',
    ]);
    // El importe llega como cadena decimal, nunca como número: es dinero.
    const aji = mio!.options.find((o) => o.name === 'Con ají extra')!;
    expect(aji.priceDelta).toBe('1.5000');

    // Y el producto dice a qué grupos está unido, que es la pregunta que se
    // hace quien edita la carta: «¿a este pollo se le elige guarnición?».
    const producto = await a(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'CON-GRUPO', name: 'Plato con opciones' })
      .expect(201);
    await a(
      http().post(
        `/api/v1/catalog/products/${producto.body.id}/modifier-groups`,
      ),
    )
      .send({ groupId: grupo.body.id })
      .expect(201);

    const carta = await a(
      http().get(`/api/v1/catalog/products?brand=${marcaA}`),
    ).expect(200);
    const enCarta = (carta.body as AdminProductView[]).find(
      (p) => p.id === producto.body.id,
    );
    expect(enCarta!.modifierGroupIds).toEqual([grupo.body.id]);

    // Y al desunirlo desaparece: sin esto, «quitar» sería solo visual y el
    // cliente seguiría viendo la pregunta en la tienda.
    await a(
      http().delete(
        `/api/v1/catalog/products/${producto.body.id}/modifier-groups/${grupo.body.id}`,
      ),
    ).expect(200);
    const despues = await a(
      http().get(`/api/v1/catalog/products?brand=${marcaA}`),
    ).expect(200);
    expect(
      (despues.body as AdminProductView[]).find(
        (p) => p.id === producto.body.id,
      )!.modifierGroupIds,
    ).toEqual([]);
  });

  it('AISLAMIENTO: B no puede listar los modificadores de la marca de A', async () => {
    // La marca va en la consulta. Sin filtro por tenant, B leería la carta de
    // opciones del competidor —y sus precios— con una sola petición.
    await como(tokenA)(http().post('/api/v1/catalog/modifier-groups'))
      .send({ brandId: marcaA, name: 'Grupo privado de A' })
      .expect(201);

    const r = await como(tokenB)(
      http().get(`/api/v1/catalog/modifier-groups?brand=${marcaA}`),
    ).expect(200);
    expect(r.body).toEqual([]);
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

  it('LA FOTO se pone y se quita sin tocar nada más del plato', async () => {
    // El motivo de que esto sea un endpoint aparte y no un campo del upsert:
    // el upsert reescribe TODAS las columnas, y la lista del panel no devuelve
    // ni la descripción ni los alérgenos. Cambiar la foto por ahí los dejaría
    // en blanco sin un solo error a la vista. Un plato que pierde sus alérgenos
    // es un problema de salud, no de datos.
    const a = como(tokenA);
    const creado = await a(http().post('/api/v1/catalog/products'))
      .send({
        brandId: marcaA,
        sku: 'CON-FOTO',
        name: 'Pollo a la brasa',
        description: 'Un cuarto con papas y ensalada.',
        allergens: ['gluten'],
      })
      .expect(201);
    const id = creado.body.id as string;

    const puesta = await a(http().post(`/api/v1/catalog/products/${id}/image`))
      .send({ imageUrl: 'https://fotos.ejemplo.pe/pollo.jpg' })
      .expect(201);
    expect(puesta.body.imageUrl).toBe('https://fotos.ejemplo.pe/pollo.jpg');

    // Lo que de verdad importa: la descripción y los alérgenos SIGUEN AHÍ.
    const intactos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        description: string | null;
        allergens: string[] | null;
        image_url: string | null;
      }>(
        `SELECT description, allergens, image_url FROM cat_products WHERE id = $1`,
        [id],
      );
      return rows[0]!;
    });
    expect(intactos.description).toBe('Un cuarto con papas y ensalada.');
    expect(intactos.allergens).toEqual(['gluten']);
    expect(intactos.image_url).toBe('https://fotos.ejemplo.pe/pollo.jpg');

    // Y el panel la devuelve, que es lo que permite enseñar la miniatura.
    const panel = await a(
      http().get(`/api/v1/catalog/products?brand=${marcaA}`),
    ).expect(200);
    const fila = panel.body.find((p: { id: string }) => p.id === id);
    expect(fila.imageUrl).toBe('https://fotos.ejemplo.pe/pollo.jpg');

    // `null` la quita: es la única forma de deshacer una URL mal pegada.
    const quitada = await a(http().post(`/api/v1/catalog/products/${id}/image`))
      .send({ imageUrl: null })
      .expect(201);
    expect(quitada.body.imageUrl).toBeNull();
  });

  it('una foto por http se RECHAZA: rompería la tienda del cliente', async () => {
    // Servida por http, el navegador marca la tienda entera como insegura —o
    // bloquea la imagen y deja el hueco—. El dueño vería su tienda «rota» sin
    // saber por qué, y el fallo estaría a una pantalla de distancia de la causa.
    const creado = await como(tokenA)(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'FOTO-INSEGURA', name: 'Ceviche' })
      .expect(201);

    const mala = await como(tokenA)(
      http().post(`/api/v1/catalog/products/${creado.body.id}/image`),
    )
      .send({ imageUrl: 'http://fotos.ejemplo.pe/ceviche.jpg' })
      .expect(422);
    expect(mala.body.detail).toContain('https');

    await como(tokenA)(
      http().post(`/api/v1/catalog/products/${creado.body.id}/image`),
    )
      .send({ imageUrl: 'no es una dirección' })
      .expect(422);
  });

  // -------------------------------------------------- IMPORTAR DESDE EXCEL

  /** Una hoja como la exporta un Excel en español: `;` y coma decimal. */
  const HOJA = [
    'sku;nombre;categoria;precio_base;precio_web',
    'IMP-1;Lomo saltado;Criollos;S/ 32,00;35,00',
    'IMP-2;Arroz chaufa;Criollos;28,50;',
    'IMP-3;Chicha morada;Bebidas;8,00;',
  ].join('\n');

  it('LA VISTA PREVIA no escribe nada, y dice qué pasaría', async () => {
    // docs/26 pide «nunca publicar sin revisión humana» y specs/ux/03
    // «publicación explícita con diff». Sin simulación, pegar una hoja con un
    // cero de más publica ciento ochenta precios malos antes de que nadie mire.
    const otra = await montarNegocio(tokenA, '20512345690', 'Importar');
    const previa = await como(tokenA)(http().post('/api/v1/catalog/import'))
      .send({ brandId: otra.brandId, csv: HOJA, dryRun: true })
      .expect(201);

    expect(previa.body.simulacion).toBe(true);
    expect(previa.body.nuevos).toBe(3);
    expect(previa.body.actualizados).toBe(0);
    expect(previa.body.categoriasNuevas).toEqual(
      expect.arrayContaining(['Criollos', 'Bebidas']),
    );
    // El precio se lee con COMA decimal: `S/ 32,00` son treinta y dos soles.
    const lomo = previa.body.filas.find(
      (f: { sku: string }) => f.sku === 'IMP-1',
    );
    expect(lomo.precioBase).toBe('32.0000');

    // Y LO QUE IMPORTA: la carta sigue vacía.
    const carta = await como(tokenA)(
      http().get(`/api/v1/catalog/products?brand=${otra.brandId}`),
    ).expect(200);
    expect(carta.body).toHaveLength(0);
  });

  it('APLICAR crea los platos, sus categorías y sus precios por canal', async () => {
    const otra = await montarNegocio(tokenA, '20512345691', 'Importar2');
    const hecho = await como(tokenA)(http().post('/api/v1/catalog/import'))
      .send({ brandId: otra.brandId, csv: HOJA, dryRun: false })
      .expect(201);
    expect(hecho.body.simulacion).toBe(false);

    const carta = await como(tokenA)(
      http().get(`/api/v1/catalog/products?brand=${otra.brandId}`),
    ).expect(200);
    expect(carta.body).toHaveLength(3);

    const lomo = carta.body.find((p: { sku: string }) => p.sku === 'IMP-1');
    expect(lomo.categoryName).toBe('Criollos');
    // Precio base Y precio de canal, que es la columna `precio_web`.
    const base = lomo.prices.find(
      (x: { channel: string | null }) => x.channel === null,
    );
    const web = lomo.prices.find(
      (x: { channel: string | null }) => x.channel === 'web',
    );
    expect(base.price).toBe('32.0000');
    expect(web.price).toBe('35.0000');
  });

  it('VOLVER A IMPORTAR la misma hoja no duplica y no marca cambios', async () => {
    // Es el caso normal: se corrige una fila y se vuelve a pegar la hoja
    // entera. Si la segunda pasada duplicara, la carta quedaría con dos «Lomo
    // saltado» a precios distintos y ningún modo de saber cuál cobra la caja.
    const otra = await montarNegocio(tokenA, '20512345692', 'Importar3');
    await como(tokenA)(http().post('/api/v1/catalog/import'))
      .send({ brandId: otra.brandId, csv: HOJA, dryRun: false })
      .expect(201);

    const segunda = await como(tokenA)(http().post('/api/v1/catalog/import'))
      .send({ brandId: otra.brandId, csv: HOJA, dryRun: true })
      .expect(201);
    expect(segunda.body.nuevos).toBe(0);
    expect(segunda.body.sinCambios).toBe(3);

    const carta = await como(tokenA)(
      http().get(`/api/v1/catalog/products?brand=${otra.brandId}`),
    ).expect(200);
    expect(carta.body).toHaveLength(3);
  });

  it('UN CAMBIO DE PRECIO se ve en la previa ANTES de aplicarlo', async () => {
    const otra = await montarNegocio(tokenA, '20512345693', 'Importar4');
    await como(tokenA)(http().post('/api/v1/catalog/import'))
      .send({ brandId: otra.brandId, csv: HOJA, dryRun: false })
      .expect(201);

    const subida = HOJA.replace('S/ 32,00', 'S/ 39,90');
    const previa = await como(tokenA)(http().post('/api/v1/catalog/import'))
      .send({ brandId: otra.brandId, csv: subida, dryRun: true })
      .expect(201);

    const lomo = previa.body.filas.find(
      (f: { sku: string }) => f.sku === 'IMP-1',
    );
    expect(lomo.efecto).toBe('actualiza');
    expect(lomo.precioAnterior).toBe('32.0000');
    expect(lomo.precioBase).toBe('39.9000');
    expect(previa.body.actualizados).toBe(1);
    expect(previa.body.sinCambios).toBe(2);
  });

  it('UNA HOJA MALA se rechaza ENTERA, nombrando la fila', async () => {
    // Nada de importar 139 y morir en la 140: una carta a medio importar es
    // peor que ninguna, porque nadie sabe dónde se cortó.
    const otra = await montarNegocio(tokenA, '20512345694', 'Importar5');
    const mala = [
      'sku;nombre;precio_base',
      'MAL-1;Bien;10,00',
      'MAL-2;Mal;no es un precio',
    ].join('\n');

    const res = await como(tokenA)(http().post('/api/v1/catalog/import'))
      .send({ brandId: otra.brandId, csv: mala, dryRun: false })
      .expect(422);
    expect(res.body.detail).toContain('fila 3');

    const carta = await como(tokenA)(
      http().get(`/api/v1/catalog/products?brand=${otra.brandId}`),
    ).expect(200);
    expect(carta.body).toHaveLength(0);
  });

  it('un SKU REPETIDO es un error, no «gana el último»', async () => {
    // En una hoja de 180 líneas, quedarse con el último hace desaparecer un
    // producto sin que nadie lo note.
    const otra = await montarNegocio(tokenA, '20512345695', 'Importar6');
    const repe = [
      'sku;nombre;precio_base',
      'DUP-1;Uno;10,00',
      'DUP-1;Otro;12,00',
    ].join('\n');

    await como(tokenA)(http().post('/api/v1/catalog/import'))
      .send({ brandId: otra.brandId, csv: repe, dryRun: true })
      .expect(422);
  });

  it('por DEFECTO simula: escribir hay que pedirlo', async () => {
    // Al revés —aplicar salvo que digas lo contrario— una llamada a medio
    // escribir publicaría la carta sin que nadie la mire.
    const otra = await montarNegocio(tokenA, '20512345696', 'Importar7');
    const res = await como(tokenA)(http().post('/api/v1/catalog/import'))
      .send({ brandId: otra.brandId, csv: HOJA })
      .expect(201);
    expect(res.body.simulacion).toBe(true);

    const carta = await como(tokenA)(
      http().get(`/api/v1/catalog/products?brand=${otra.brandId}`),
    ).expect(200);
    expect(carta.body).toHaveLength(0);
  });

  // ------------------------------------------------------ AISLAMIENTO

  it('AISLAMIENTO: B no puede importar una carta en la marca de A', async () => {
    // La comprobación obligatoria del endpoint nuevo, y aquí el daño sería el
    // mayor de todos: una importación reescribe la carta ENTERA de una marca.
    await como(tokenB)(http().post('/api/v1/catalog/import'))
      .send({ brandId: marcaA, csv: HOJA, dryRun: false })
      .expect(404);

    const intrusos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM cat_products WHERE sku LIKE 'IMP-%'
           AND brand_id = $1`,
        [marcaA],
      );
      return Number(rows[0]!.n);
    });
    expect(intrusos).toBe(0);
  });

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

  it('AISLAMIENTO: B no puede cambiarle la foto a un producto de A', async () => {
    // La comprobación obligatoria del endpoint nuevo. Es menos evidente que la
    // del precio y no es menos grave: una foto ajena en la carta del rival
    // —o una imagen cualquiera— es un defacement de la tienda de A.
    const producto = await como(tokenA)(http().post('/api/v1/catalog/products'))
      .send({ brandId: marcaA, sku: 'FOTO-AISLADA', name: 'Plato de A' })
      .expect(201);
    await como(tokenA)(
      http().post(`/api/v1/catalog/products/${producto.body.id}/image`),
    )
      .send({ imageUrl: 'https://fotos.ejemplo.pe/de-a.jpg' })
      .expect(201);

    await como(tokenB)(
      http().post(`/api/v1/catalog/products/${producto.body.id}/image`),
    )
      .send({ imageUrl: 'https://fotos.ejemplo.pe/de-b.jpg' })
      .expect(404);

    const sigue = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ image_url: string | null }>(
        `SELECT image_url FROM cat_products WHERE id = $1`,
        [producto.body.id],
      );
      return rows[0]!.image_url;
    });
    expect(sigue).toBe('https://fotos.ejemplo.pe/de-a.jpg');
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
