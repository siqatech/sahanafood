import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import { StorefrontService } from '../modules/storefront/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Tienda web (spec 11, T5.08–T5.13).
 *
 * Los cuatro casos que la spec marca como bloqueantes, más el que hace que este
 * producto sea vendible como SaaS:
 *
 * · **Aislamiento por dominio.** El host de la marca A no sirve el catálogo de
 *   B. Es LA prueba de este módulo: la tienda es la única superficie del
 *   sistema que atiende sin sesión, así que el tenant sale del host o no sale
 *   de ningún sitio. Si esto falla, un competidor ve precios ajenos desde su
 *   propio dominio.
 * · **Agotado entre carrito y checkout.** Validar solo al agregar deja cobrar
 *   comida que no existe (RN-STO-02).
 * · **Zona sin cobertura.** No es un error: es `pickup` con motivo. Un error
 *   pierde la venta; «no llegamos, pero puedes recoger» la conserva.
 * · **Pago fallido → carrito recuperable.** El carrito vive en el servidor
 *   justo para esto: la gente cierra la pestaña cuando le rebota la tarjeta.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const HOST_A = 'buensabor.sahana.food';
const HOST_B = 'wokexpress-otro.sahana.food';

suite('Tienda web', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tenantB = '';
  let tokenAdminA = '';
  let brandA = '';
  let brandB = '';
  let orgA: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let catA: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let catB: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let storefront: StorefrontService;

  const alta = async (
    tenantId: string,
    brandId: string,
    host: string,
  ): Promise<void> => {
    const dominio = await storefront.registerDomain(tenantId, {
      brandId,
      host,
    });
    await storefront.verifyDomain(tenantId, dominio.id);
  };

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
    storefront = app.get(StorefrontService);

    await seedPlans(pool);

    // El host es único GLOBALMENTE —es lo que impide el secuestro de tiendas—,
    // así que una ejecución que se cae a medias deja el dominio reservado y la
    // siguiente no arranca. Se limpia por nombre para que la suite se pueda
    // repetir sin tocar la base a mano.
    await pool.query('DELETE FROM ten_tenants WHERE name LIKE $1', [
      'Tienda Tenant %',
    ]);

    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'Tienda Tenant A',
      planCode: 'growth',
      owner: {
        email: 'sto-a@sahana.test',
        password: 'password-sto-a-1',
        fullName: 'Dueña Tienda A',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    const b = await tenancy.provisionTenant({
      name: 'Tienda Tenant B',
      planCode: 'growth',
      owner: {
        email: 'sto-b@sahana.test',
        password: 'password-sto-b-1',
        fullName: 'Dueño Tienda B',
      },
    });
    tenantB = b.tenantId;
    created.push(tenantB);

    orgA = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandA = orgA.brandIds[0]!;
    catA = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId: brandA, locationId: orgA.locationId }),
    );

    const orgB = await withTenant(pool, tenantB, (ctx) =>
      seedDemoOrganization(ctx),
    );
    brandB = orgB.brandIds[0]!;
    catB = await withTenant(pool, tenantB, (ctx) =>
      seedDemoCatalog(ctx, { brandId: brandB, locationId: orgB.locationId }),
    );

    await alta(tenantA, brandA, HOST_A);
    await alta(tenantB, brandB, HOST_B);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'sto-a@sahana.test', password: 'password-sto-a-1' })
      .expect(201);
    tokenAdminA = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());

  /** Abre un carrito en un host y devuelve su token público. */
  const abrirCarrito = async (host: string): Promise<string> => {
    const r = await http()
      .post('/api/v1/shop/carts')
      .set('host', host)
      .expect(201);
    return r.body.token as string;
  };

  // ------------------------------------------------- Aislamiento por dominio

  it('BLOQUEANTE: el host de la marca A no sirve el catálogo de B', async () => {
    const a = await http()
      .get('/api/v1/shop/context')
      .set('host', HOST_A)
      .expect(200);
    const b = await http()
      .get('/api/v1/shop/context')
      .set('host', HOST_B)
      .expect(200);

    expect(a.body.brandId).toBe(brandA);
    expect(b.body.brandId).toBe(brandB);
    expect(a.body.brandId).not.toBe(b.body.brandId);

    // Y lo que de verdad importa: un producto de B no entra en un carrito de A.
    // El id existe y es válido —solo que en otro tenant—, así que si el
    // servicio confiara en el payload en vez de en el host, esto pasaría.
    const carrito = await abrirCarrito(HOST_A);
    const cruzado = await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({ productId: catB.polloId, quantity: 1 })
      .expect(422);
    expect(cruzado.body.detail).toMatch(/no está disponible/i);
  });

  it('el host del visitante llega por x-forwarded-host cuando hay proxy delante', async () => {
    // Detrás de un proxy —y el servidor de Next lo es— el `host` es el del
    // salto interno. Si mandara ese, TODAS las tiendas servirían la misma
    // marca, y sin ruido: la página carga igual, solo que con el catálogo
    // equivocado. Costó encontrarlo una vez; esta prueba es para no repetirlo.
    const r = await http()
      .get('/api/v1/shop/context')
      .set('host', 'balanceador.interno')
      .set('x-forwarded-host', HOST_A)
      .expect(200);
    expect(r.body.brandId).toBe(brandA);

    // Con varios saltos manda el primero, que es el del cliente.
    const cadena = await http()
      .get('/api/v1/shop/context')
      .set('host', 'balanceador.interno')
      .set('x-forwarded-host', `${HOST_A}, interno.privado`)
      .expect(200);
    expect(cadena.body.brandId).toBe(brandA);
  });

  it('un host sin tienda no dice si el dominio existe', async () => {
    // Mismo 404 para «no registrado» y «registrado pero sin verificar»: si
    // distinguiera, cualquiera sabría qué dominios están a medio configurar.
    await http()
      .get('/api/v1/shop/context')
      .set('host', 'nadie.example')
      .expect(404);

    const pendiente = await storefront.registerDomain(tenantA, {
      brandId: brandA,
      host: 'pendiente.example',
    });
    expect(pendiente.status).toBe('pending');
    await http()
      .get('/api/v1/shop/context')
      .set('host', 'pendiente.example')
      .expect(404);
  });

  it('dos tenants no pueden reclamar el mismo host', async () => {
    // La unicidad global del host es lo que hace imposible el secuestro de una
    // tienda ajena registrando su dominio desde otra cuenta.
    await expect(
      storefront.registerDomain(tenantB, { brandId: brandB, host: HOST_A }),
    ).rejects.toThrow();
  });

  // ------------------------------------------------------- Carrito y compra

  it('compra de invitado de punta a punta', async () => {
    const carrito = await abrirCarrito(HOST_A);

    const conLinea = await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 2,
        modifierOptionIds: [catA.optionGrandeId],
      })
      .expect(201);
    // Precio web (32) + «Grande» (5) = 37, × 2. El modificador entra en el
    // precio del carrito: si no entrara, el cliente vería 64 y pagaría 74.
    expect(conLinea.body.subtotal).toBe('74.0000');
    expect(
      conLinea.body.blockers.map((b: { code: string }) => b.code),
    ).toContain('NO_ADDRESS');

    // Dirección DENTRO de la zona céntrica (la barata: gana por RN-ORG-02).
    const conDireccion = await http()
      .post(`/api/v1/shop/carts/${carrito}/address`)
      .send({ address: 'Av. Larco 100, Miraflores', lat: -12.125, lng: -77.02 })
      .expect(201);
    expect(conDireccion.body.fulfillment).toBe('delivery');
    expect(Number(conDireccion.body.deliveryFee)).toBeGreaterThan(0);

    const conCliente = await http()
      .post(`/api/v1/shop/carts/${carrito}/customer`)
      .send({ name: 'Ana Compradora', phone: '+51987654321' })
      .expect(201);
    expect(conCliente.body.blockers).toHaveLength(0);

    const pedido = await http()
      .post(`/api/v1/shop/carts/${carrito}/checkout`)
      .expect(201);
    expect(pedido.body.orderId).toBeTruthy();
    expect(pedido.body.total).toBe(conCliente.body.total);

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ status: string; order_id: string }>(
        `SELECT c.status, c.order_id FROM sto_carts c
           JOIN pub_tokens t ON t.resource_id = c.id
          WHERE t.token = $1`,
        [carrito],
      );
      return rows[0]!;
    });
    expect(fila.status).toBe('ordered');
    expect(fila.order_id).toBe(pedido.body.orderId);
  });

  it('LA CANTIDAD SE CAMBIA sin rehacer la línea, y bajar a cero la quita', async () => {
    // Es la operación más usada de un carrito y era la única que no existía.
    // Sin ella, «quiero dos» obliga a añadir el producto otra vez —y `addLine`
    // siempre inserta, así que salen DOS líneas de uno— o a quitarlo y volver a
    // elegir todos los modificadores desde cero.
    const carrito = await abrirCarrito(HOST_A);
    const conLinea = await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 1,
        modifierOptionIds: [catA.optionGrandeId],
      })
      .expect(201);
    const lineaId = conLinea.body.lines[0].id;
    expect(conLinea.body.subtotal).toBe('37.0000');

    const aTres = await http()
      .patch(`/api/v1/shop/carts/${carrito}/lines/${lineaId}`)
      .send({ quantity: 3 })
      .expect(200);
    // Sigue habiendo UNA línea, con tres unidades: 37 × 3.
    expect(aTres.body.lines).toHaveLength(1);
    expect(aTres.body.lines[0].quantity).toBe(3);
    expect(aTres.body.subtotal).toBe('111.0000');

    // El cero significa «quítalo»: así el botón «−» no necesita una segunda
    // acción distinta al llegar a uno.
    const aCero = await http()
      .patch(`/api/v1/shop/carts/${carrito}/lines/${lineaId}`)
      .send({ quantity: 0 })
      .expect(200);
    expect(aCero.body.lines).toHaveLength(0);
  });

  it('UNA CANTIDAD ABSURDA se rechaza: el carrito es público y sin autenticar', async () => {
    // El tope no es una regla de negocio, es un freno. Sin él, un número
    // cualquiera se convierte en una comanda que alguien cancela a mano y en un
    // stock que se va a negativo.
    const carrito = await abrirCarrito(HOST_A);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({ productId: catA.comboId, quantity: 5000 })
      .expect(422);

    const ok = await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({ productId: catA.comboId, quantity: 1 })
      .expect(201);
    await http()
      .patch(`/api/v1/shop/carts/${carrito}/lines/${ok.body.lines[0].id}`)
      .send({ quantity: 5000 })
      .expect(422);
  });

  it('el catálogo público sale del host y respeta el canal web', async () => {
    const r = await http()
      .get('/api/v1/shop/catalog')
      .set('host', HOST_A)
      .expect(200);
    expect(r.body.brandId).toBe(brandA);
    expect(r.body.channel).toBe('web');

    const ids = r.body.products.map((p: { id: string }) => p.id);
    expect(ids).toContain(catA.polloId);
    // El producto que solo tiene precio en POS no aparece en la tienda
    // (RN-CAT-01): enseñarlo sin precio de web sería prometer algo que el
    // pedido rechazaría después.
    expect(ids).not.toContain(catA.soloPosId);
  });

  it('un grupo obligatorio sin elegir se rechaza AL AGREGAR, no en el checkout', async () => {
    // Enterarse de que faltaba elegir el tamaño con la tarjeta ya en la mano es
    // el peor momento posible. La validación usa la misma función que el
    // pedido, así que la tienda y la caja no pueden discrepar.
    const carrito = await abrirCarrito(HOST_A);
    const r = await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({ productId: catA.polloId, quantity: 1 })
      .expect(422);
    expect(r.body.code).toBe('MODIFIER_MIN_NOT_MET');

    // Y una opción que no es de este producto tampoco cuela: ignorarla dejaría
    // colar la opción de otro plato y salir con un precio que no existe.
    await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 1,
        modifierOptionIds: [catA.optionGrandeId, catB.optionQuesoId],
      })
      .expect(422);
  });

  it('el consentimiento de marketing es una decisión aparte y guarda su texto', async () => {
    const carrito = await abrirCarrito(HOST_A);

    // Un booleano suelto no acredita nada (Ley 29733): sin el texto exacto, se
    // rechaza en vez de guardar un consentimiento que no se puede demostrar.
    await http()
      .post(`/api/v1/shop/carts/${carrito}/customer`)
      .send({ name: 'Ana', phone: '+51900000000', marketingConsent: true })
      .expect(422);

    await http()
      .post(`/api/v1/shop/carts/${carrito}/customer`)
      .send({
        name: 'Ana',
        phone: '+51900000000',
        marketingConsent: true,
        marketingConsentText:
          'Acepto recibir promociones de Pollería El Buen Sabor.',
      })
      .expect(201);

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        marketing_consent: boolean;
        marketing_consent_text: string | null;
        marketing_consent_at: Date | null;
      }>(
        `SELECT c.marketing_consent, c.marketing_consent_text, c.marketing_consent_at
           FROM sto_carts c JOIN pub_tokens t ON t.resource_id = c.id
          WHERE t.token = $1`,
        [carrito],
      );
      return rows[0]!;
    });
    expect(fila.marketing_consent).toBe(true);
    expect(fila.marketing_consent_text).toContain('promociones');
    expect(fila.marketing_consent_at).not.toBeNull();
  });

  // ------------------------------------------------------------ Bloqueantes

  it('BLOQUEANTE: se agota entre el carrito y el checkout', async () => {
    const carrito = await abrirCarrito(HOST_A);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 1,
        modifierOptionIds: [catA.optionGrandeId],
      })
      .expect(201);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/address`)
      .send({ address: 'Av. Larco 100', lat: -12.125, lng: -77.02 })
      .expect(201);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/customer`)
      .send({ name: 'Ana', phone: '+51987654321' })
      .expect(201);

    // Se acaba el pollo MIENTRAS el cliente rellena sus datos.
    await http()
      .post(`/api/v1/catalog/products/${catA.polloId}/pause`)
      .set('authorization', `Bearer ${tokenAdminA}`)
      .send({ channels: ['web'], reason: 'Se acabó' })
      .expect(201);

    const bloqueado = await http()
      .post(`/api/v1/shop/carts/${carrito}/checkout`)
      .expect(422);
    expect(bloqueado.body.detail).toMatch(/no está disponible/i);

    // La línea NO desaparece: se marca. Borrarla en silencio se siente como un
    // fallo de la tienda y el cliente no entiende qué pasó.
    const vista = await http().get(`/api/v1/shop/carts/${carrito}`).expect(200);
    expect(vista.body.lines).toHaveLength(1);
    expect(vista.body.lines[0].unavailable).toBe(true);
    expect(vista.body.subtotal).toBe('0.0000');

    // Quitar la línea agotada devuelve el carrito a un estado comprable.
    await http()
      .delete(`/api/v1/shop/carts/${carrito}/lines/${vista.body.lines[0].id}`)
      .expect(200);

    await withTenant(pool, tenantA, ({ client }) =>
      client.query('DELETE FROM cat_product_pauses WHERE product_id = $1', [
        catA.polloId,
      ]),
    );
  });

  it('BLOQUEANTE: dirección sin cobertura → recojo, no error', async () => {
    const carrito = await abrirCarrito(HOST_A);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 1,
        modifierOptionIds: [catA.optionGrandeId],
      })
      .expect(201);

    // Cusco: fuera de cualquier zona de Lima.
    const vista = await http()
      .post(`/api/v1/shop/carts/${carrito}/address`)
      .send({ address: 'Plaza de Armas, Cusco', lat: -13.516, lng: -71.978 })
      .expect(201);

    expect(vista.body.fulfillment).toBe('pickup');
    expect(vista.body.deliveryFee).toBe('0.0000');
    // Y sobre todo: sin cobertura NO es un bloqueo de dirección. La venta sigue
    // viva, solo que el cliente recoge.
    expect(
      vista.body.blockers.map((b: { code: string }) => b.code),
    ).not.toContain('NO_ADDRESS');

    await http()
      .post(`/api/v1/shop/carts/${carrito}/customer`)
      .send({ name: 'Ana', phone: '+51987654321' })
      .expect(201);
    await http().post(`/api/v1/shop/carts/${carrito}/checkout`).expect(201);
  });

  it('BLOQUEANTE: pago fallido → el carrito sigue ahí', async () => {
    // El carrito vive en el servidor. Se comprueba con un token en frío: no hay
    // sesión, no hay cookie, no hay localStorage — solo el enlace.
    const carrito = await abrirCarrito(HOST_A);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 3,
        modifierOptionIds: [catA.optionGrandeId],
      })
      .expect(201);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/customer`)
      .send({ name: 'Ana', phone: '+51987654321' })
      .expect(201);

    // El cliente cierra la pestaña. Vuelve por el enlace y encuentra lo suyo.
    const recuperado = await http()
      .get(`/api/v1/shop/carts/${carrito}`)
      .expect(200);
    expect(recuperado.body.status).toBe('open');
    expect(recuperado.body.lines).toHaveLength(1);
    expect(recuperado.body.lines[0].quantity).toBe(3);
  });

  it('un carrito ya convertido no se cobra dos veces', async () => {
    const carrito = await abrirCarrito(HOST_A);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 1,
        modifierOptionIds: [catA.optionGrandeId],
      })
      .expect(201);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/address`)
      .send({ address: 'Av. Larco 100', lat: -12.125, lng: -77.02 })
      .expect(201);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/customer`)
      .send({ name: 'Ana', phone: '+51987654321' })
      .expect(201);

    await http().post(`/api/v1/shop/carts/${carrito}/checkout`).expect(201);
    await http().post(`/api/v1/shop/carts/${carrito}/checkout`).expect(422);
  });

  it('un token de carrito inventado no abre nada', async () => {
    await http().get('/api/v1/shop/carts/token-que-no-existe').expect(404);
  });

  // ----------------------------------------------------------------- Cupones

  it('el cupón descuenta, respeta el mínimo y cuenta sus usos', async () => {
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `INSERT INTO sto_coupons
           (tenant_id, brand_id, code, kind, percent_bps, min_order, max_uses)
         VALUES ($1,$2,'BIENVENIDO','percent',1000,'50.0000',1)`,
        [tenantA, brandA],
      ),
    );

    const carrito = await abrirCarrito(HOST_A);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 1,
        modifierOptionIds: [catA.optionGrandeId],
      })
      .expect(201);

    // 37 < 50: por debajo del mínimo. Se informa, no se aplica en silencio.
    const bajoMinimo = await http()
      .post(`/api/v1/shop/carts/${carrito}/coupon`)
      .send({ code: 'bienvenido' })
      .expect(201);
    expect(bajoMinimo.body.coupon.applied).toBe(false);
    expect(bajoMinimo.body.coupon.reason).toBe('COUPON_BELOW_MINIMUM');
    expect(bajoMinimo.body.discount).toBe('0.0000');

    // Con dos: 74 ≥ 50. 10 % de 74 = 7,40 — sobre el SUBTOTAL, no sobre el
    // total con envío: descontar del envío regala el margen del repartidor.
    await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 1,
        modifierOptionIds: [catA.optionGrandeId],
      })
      .expect(201);
    const aplicado = await http()
      .get(`/api/v1/shop/carts/${carrito}`)
      .expect(200);
    expect(aplicado.body.coupon.applied).toBe(true);
    expect(aplicado.body.discount).toBe('7.4000');

    await http()
      .post(`/api/v1/shop/carts/${carrito}/address`)
      .send({ address: 'Av. Larco 100', lat: -12.125, lng: -77.02 })
      .expect(201);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/customer`)
      .send({ name: 'Ana', phone: '+51987654321' })
      .expect(201);
    await http().post(`/api/v1/shop/carts/${carrito}/checkout`).expect(201);

    // El contador sube EN LA MISMA transacción que la conversión: uno que se
    // actualiza después deja pasar cien usos de un cupón de uno.
    const usos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ used_count: number }>(
        "SELECT used_count FROM sto_coupons WHERE code = 'BIENVENIDO'",
      );
      return rows[0]!.used_count;
    });
    expect(usos).toBe(1);

    // Agotado: el siguiente carrito ya no lo aprovecha.
    const otro = await abrirCarrito(HOST_A);
    await http()
      .post(`/api/v1/shop/carts/${otro}/lines`)
      .send({
        productId: catA.polloId,
        quantity: 2,
        modifierOptionIds: [catA.optionGrandeId],
      })
      .expect(201);
    const agotado = await http()
      .post(`/api/v1/shop/carts/${otro}/coupon`)
      .send({ code: 'BIENVENIDO' })
      .expect(201);
    expect(agotado.body.coupon.applied).toBe(false);
    expect(agotado.body.coupon.reason).toBe('COUPON_EXHAUSTED');
  });

  it('LA OFERTA DE BIENVENIDA se anuncia sola, y solo si se puede usar', async () => {
    // Es lo que convierte la tienda en algo que capta clientes: quien llega de
    // un enlace no conoce ningún código, así que un descuento de primera compra
    // que hay que teclear de memoria no lo usa nadie.
    //
    // Y lo que se comprueba de verdad es lo contrario: que un cupón CADUCADO o
    // AGOTADO no se anuncie. Prometer en el escaparate un descuento que la caja
    // va a rechazar es peor que no ofrecer ninguno — el cliente llega al total,
    // ve otra cifra y la culpa es del local.
    const sinOferta = await http()
      .get('/api/v1/shop/context')
      .set('host', HOST_A)
      .expect(200);
    expect(sinOferta.body.welcome).toBeNull();

    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `INSERT INTO sto_coupons
           (tenant_id, brand_id, code, kind, percent_bps, min_order, is_welcome)
         VALUES ($1,$2,'HOLA','percent',1500,'40.0000',true)`,
        [tenantA, brandA],
      ),
    );

    const conOferta = await http()
      .get('/api/v1/shop/context')
      .set('host', HOST_A)
      .expect(200);
    expect(conOferta.body.welcome.code).toBe('HOLA');
    // El TEXTO lo redacta el servidor: componerlo en la tienda sería duplicar
    // en el navegador una regla de precios.
    expect(conOferta.body.welcome.label).toBe(
      '15 % de descuento en pedidos desde S/ 40.00',
    );

    // Caducada: deja de anunciarse.
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE sto_coupons SET valid_until = now() - interval '1 day'
          WHERE code = 'HOLA' AND brand_id = $1`,
        [brandA],
      ),
    );
    const caducada = await http()
      .get('/api/v1/shop/context')
      .set('host', HOST_A)
      .expect(200);
    expect(caducada.body.welcome).toBeNull();

    // Agotada: tampoco.
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE sto_coupons
            SET valid_until = NULL, max_uses = 1, used_count = 1
          WHERE code = 'HOLA' AND brand_id = $1`,
        [brandA],
      ),
    );
    const agotada = await http()
      .get('/api/v1/shop/context')
      .set('host', HOST_A)
      .expect(200);
    expect(agotada.body.welcome).toBeNull();

    await withTenant(pool, tenantA, ({ client }) =>
      client.query(`DELETE FROM sto_coupons WHERE code = 'HOLA'`),
    );
  });

  it('SOLO UNA BIENVENIDA por marca: activar la nueva apaga la anterior', async () => {
    // Con dos marcadas a la vez, cuál se anuncia lo decidiría el orden que
    // devuelva la base, que cambia sin avisar. El día que el dueño crea la
    // promoción de fiestas sin acordarse de apagar la anterior, la tienda
    // anunciaría una y el cliente encontraría otra.
    const primera = await storefront.upsertCoupon(tenantA, {
      brandId: brandA,
      code: 'primera',
      kind: 'percent',
      percentBps: 1000,
      isWelcome: true,
    });
    // Y de paso: el código se guarda en mayúsculas, porque quien lo teclea en
    // un móvil escribe «primera» tanto como «PRIMERA».
    expect(primera.code).toBe('PRIMERA');
    expect(primera.isWelcome).toBe(true);

    const segunda = await storefront.upsertCoupon(tenantA, {
      brandId: brandA,
      code: 'SEGUNDA',
      kind: 'percent',
      percentBps: 2000,
      isWelcome: true,
    });
    expect(segunda.isWelcome).toBe(true);

    const todas = await storefront.listCoupons(tenantA);
    const bienvenidas = todas.filter((c) => c.isWelcome && c.active);
    expect(bienvenidas).toHaveLength(1);
    expect(bienvenidas[0]!.code).toBe('SEGUNDA');

    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `DELETE FROM sto_coupons WHERE code IN ('PRIMERA','SEGUNDA')`,
      ),
    );
  });

  it('un código con espacios o acentos se rechaza al crearlo', async () => {
    // Se dicta por teléfono y se teclea en un móvil: «10% DESCUENTO ¡YA!» es un
    // código que nadie va a poder usar.
    await expect(
      storefront.upsertCoupon(tenantA, {
        brandId: brandA,
        code: 'PROMOCIÓN VERANO',
        kind: 'percent',
        percentBps: 1000,
      }),
    ).rejects.toThrow(/letras y números/);
  });

  it('UNA CLAVE PUBLICABLE sirve la tienda desde una web de tercero', async () => {
    // ADR-0020: el cliente puede montar su web en WordPress o en React y pedir
    // contra nuestra API. La cabecera `Host` no le vale desde un navegador —el
    // host de la petición es el nuestro—, así que la marca se dice con la
    // clave.
    const emitida = await storefront.issuePublishableKey(tenantA, {
      brandId: brandA,
      label: 'WordPress del cliente',
    });
    expect(emitida.key).toMatch(/^pk_[0-9a-f]{32}$/);

    // Sin Host de tienda, solo con la clave: el catálogo sale igual.
    const carta = await http()
      .get('/api/v1/shop/catalog')
      .set('host', 'api.sahana.food')
      .set('x-sahana-key', emitida.key)
      .expect(200);
    expect(carta.body.brandId).toBe(brandA);
    expect(carta.body.products.length).toBeGreaterThan(0);

    // Y se puede pedir de punta a punta.
    const carrito = await http()
      .post('/api/v1/shop/carts')
      .set('host', 'api.sahana.food')
      .set('x-sahana-key', emitida.key)
      .expect(201);
    expect(carrito.body.token).toBeTruthy();

    await http()
      .post(`/api/v1/shop/carts/${carrito.body.token}/lines`)
      .send({ productId: catA.comboId, quantity: 1 })
      .expect(201);
  });

  it('LA CLAVE DE UN TENANT no sirve el catálogo del otro', async () => {
    // La comprobación de aislamiento de esta vía: una clave identifica UNA
    // marca, y no hay forma de pedirle el catálogo de otra.
    const deA = await storefront.issuePublishableKey(tenantA, {
      brandId: brandA,
    });
    const carta = await http()
      .get('/api/v1/shop/catalog')
      // El host es el de la tienda de B: si el host mandara sobre la clave,
      // aquí saldría el catálogo de B.
      .set('host', HOST_B)
      .set('x-sahana-key', deA.key)
      .expect(200);
    expect(carta.body.brandId).toBe(brandA);
    expect(carta.body.brandId).not.toBe(brandB);
  });

  it('UNA CLAVE REVOCADA deja de abrir nada, y no dice que existió', async () => {
    const clave = await storefront.issuePublishableKey(tenantA, {
      brandId: brandA,
    });
    await storefront.revokePublishableKey(tenantA, clave.id);

    const r = await http()
      .get('/api/v1/shop/catalog')
      .set('host', 'api.sahana.food')
      .set('x-sahana-key', clave.key)
      .expect(404);
    // El mismo mensaje que una clave inventada: decir «fue revocada» le
    // confirmaría a quien la encontró que acertó de dónde salía.
    expect(r.body.detail).toMatch(/no es válida/);

    const inventada = await http()
      .get('/api/v1/shop/catalog')
      .set('host', 'api.sahana.food')
      .set('x-sahana-key', 'pk_0000000000000000000000000000cafe')
      .expect(404);
    expect(inventada.body.detail).toBe(r.body.detail);
  });

  it('BLOQUEANTE: el CORS solo abre a los dominios registrados', async () => {
    // Es el control que de verdad protege esta API, porque la clave es pública
    // por diseño. Un `*` aquí convertiría el catálogo y los precios de cada
    // cliente en algo que cualquier web puede montar en su página.
    const permitidos = await storefront.allowedOrigins();
    expect(permitidos).toContain(`https://${HOST_A}`);
    expect(permitidos).toContain(`https://${HOST_B}`);
    expect(permitidos).not.toContain('*');

    // Un origen cualquiera NO recibe la cabecera que autoriza al navegador a
    // leer la respuesta.
    const ajeno = await http()
      .get('/api/v1/shop/catalog')
      .set('host', HOST_A)
      .set('origin', 'https://competencia.example')
      .expect(200);
    expect(ajeno.headers['access-control-allow-origin']).toBeUndefined();

    // El dominio del propio cliente sí.
    const propio = await http()
      .get('/api/v1/shop/catalog')
      .set('host', HOST_A)
      .set('origin', `https://${HOST_A}`)
      .expect(200);
    expect(propio.headers['access-control-allow-origin']).toBe(
      `https://${HOST_A}`,
    );
  });

  it('el cupón de un tenant no vale en la tienda del otro', async () => {
    // Mismo código, otro tenant: RLS hace que ni siquiera se vea.
    const carrito = await abrirCarrito(HOST_B);
    await http()
      .post(`/api/v1/shop/carts/${carrito}/lines`)
      .send({
        productId: catB.polloId,
        quantity: 2,
        modifierOptionIds: [catB.optionGrandeId],
      })
      .expect(201);
    const r = await http()
      .post(`/api/v1/shop/carts/${carrito}/coupon`)
      .send({ code: 'BIENVENIDO' })
      .expect(201);
    expect(r.body.coupon.applied).toBe(false);
    expect(r.body.coupon.reason).toBe('COUPON_UNKNOWN');
  });
});
