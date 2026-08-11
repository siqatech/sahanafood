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
import {
  ConnectionService,
  SIMULATOR_PROVIDER,
} from '../modules/integrations/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import {
  PaymentsService,
  SettlementsService,
  CULQI_PROVIDER,
} from '../modules/payments/index.js';
import { StorefrontService } from '../modules/storefront/index.js';
import { DeliveryService } from '../modules/delivery/index.js';
import { ConversationsService } from '../modules/conversations/index.js';
import { KnowledgeService, AgentService } from '../modules/ai/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';
import {
  assertEndpointIsolation,
  type IsolationCase,
} from './isolation-harness.js';

/**
 * Suite BLOQUEANTE de aislamiento aplicada a TODOS los endpoints (T3.13).
 *
 * Al añadir un endpoint nuevo, se añade aquí su caso. El harness comprueba, sin
 * necesidad de aserciones a medida, que la respuesta del tenant A no contiene
 * ningún dato del tenant B a ninguna profundidad del JSON.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

/**
 * Día de negocio en el que SOLO el tenant B tiene facturación.
 *
 * Fijo y en el pasado: así el caso de `/analytics/reconciliation` no depende de
 * la hora a la que se ejecute la suite ni de lo que las pruebas anteriores
 * hayan hecho con los comprobantes del día de hoy.
 */
const DIA_SOLO_DE_B = '2026-01-15';

/** Hosts de tienda de cada tenant. El de B es un secreto suyo. */
const HOST_ISO_A = 'iso-a.sahana.food';
const HOST_ISO_B = 'iso-b-secreto.sahana.food';

suite('Aislamiento — todos los endpoints', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 5 });
  const created: string[] = [];

  let tokenA = '';
  let tokenB = '';
  let secretsOfB: string[] = [];
  let demoA: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let catA: Awaited<ReturnType<typeof seedDemoCatalog>>;
  /** Pedido del tenant A, para probar endpoints que operan sobre uno concreto. */
  let pedidoDeA = '';
  /**
   * Pedido de A apartado en la bandeja de excepciones. Su detalle lleva el
   * payload CRUDO del canal —con nombre y teléfono del cliente—, así que es de
   * lo más sensible que se puede pedir por id.
   */
  let excepcionDeA = '';
  /** Insumo y almacén del tenant B: A no debe poder leerlos ni ajustarlos. */
  let insumoDeB = '';
  let almacenDeB = '';
  /** Comprobante del tenant B: A no debe poder leerlo, reenviarlo ni anularlo. */
  let documentoDeB = '';
  /** Pedido del tenant B, para endpoints que operan sobre uno concreto. */
  let pedidoDeB = '';
  /**
   * Intención de cobro del tenant B. Si se filtrara, A vería cuánto cobra su
   * competencia y —peor— tendría la referencia con la que vuelve el webhook.
   */
  let intencionDeB = '';
  /** Enlace público de pago de B: quien lo tenga puede cobrar en su nombre. */
  let enlaceDeB = '';
  /** Liquidación de B: revela cuánto le cobra su pasarela. */
  let liquidacionDeB = '';
  /** Dominio de tienda de B: A no debe poder verlo ni darlo por verificado. */
  let dominioDeB = '';
  /** Repartidor y envío de B: sus nombres y su deuda de efectivo son suyos. */
  let localDeB = '';
  let tenantIdB = '';
  let repartidorDeB = '';
  let envioDeB = '';
  /** Enlace de seguimiento de B: quien lo tenga sabe dónde va un pedido ajeno. */
  let seguimientoDeB = '';
  /** Conversación de B: lo que sus clientes le escriben es lo más privado que tiene. */
  let conversacionDeB = '';
  /** Fuente de conocimiento de B: su know-how, indexado para el agente. */
  let fuenteDeB = '';

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
      name: 'Aislamiento Tenant A',
      planCode: 'growth',
      owner: {
        email: 'iso-a@sahana.test',
        password: 'password-iso-a-1',
        fullName: 'Dueño Iso A',
      },
    });
    created.push(a.tenantId);

    const b = await tenancy.provisionTenant({
      name: 'Aislamiento Tenant B SECRETO',
      planCode: 'starter',
      owner: {
        email: 'iso-b@sahana.test',
        password: 'password-iso-b-1',
        fullName: 'Dueño Iso B',
      },
    });
    created.push(b.tenantId);

    demoA = await withTenant(pool, a.tenantId, (ctx) =>
      seedDemoOrganization(ctx),
    );
    const demoB = await withTenant(pool, b.tenantId, (ctx) =>
      seedDemoOrganization(ctx),
    );

    catA = await withTenant(pool, a.tenantId, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: demoA.brandIds[0],
        locationId: demoA.locationId,
      }),
    );
    const catB = await withTenant(pool, b.tenantId, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: demoB.brandIds[0],
        locationId: demoB.locationId,
      }),
    );

    // Inventario de B, con stock real: sin stock, un endpoint que devuelve
    // vacío parecería aislado aunque no lo estuviera.
    insumoDeB = await withTenant(pool, b.tenantId, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO inv_items (tenant_id, name, unit, unit_cost)
         VALUES ($1,'Insumo SECRETO de B','g',0.05) RETURNING id`,
        [b.tenantId],
      );
      await client.query(
        `INSERT INTO inv_stock (tenant_id, warehouse_id, item_id, quantity)
         VALUES ($1,$2,$3,4321)`,
        [b.tenantId, demoB.warehouseId, rows[0]!.id],
      );
      return rows[0]!.id;
    });
    almacenDeB = demoB.warehouseId;

    // Comprobante emitido de B, con su serie y su correlativo: si algún día se
    // filtrara, el tenant A vería la facturación de un competidor.
    documentoDeB = await withTenant(pool, b.tenantId, async ({ client }) => {
      await client.query(
        `INSERT INTO bil_series (tenant_id, company_id, series, doc_type)
         VALUES ($1,$2,'B900','boleta')`,
        [b.tenantId, demoB.companyId],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO bil_documents
           (tenant_id, company_id, doc_type, status,
            series_id, series, correlative, number,
            subtotal, taxable_base, tax, total, customer_name)
         SELECT $1, $2, 'boleta', 'accepted', s.id, 'B900', 7, 'B900-00000007',
                '84.7458','84.7458','15.2542','100.0000','Cliente SECRETO de B'
           FROM bil_series s
          WHERE s.tenant_id = $1 AND s.series = 'B900'
         RETURNING id`,
        [b.tenantId, demoB.companyId],
      );
      return rows[0]!.id;
    });

    // Facturación de B en un día CERRADO del pasado. Es lo que da contenido al
    // caso de `/analytics/reconciliation`: A no facturó nada ese día, B sí, y
    // ninguna prueba posterior lo toca (las que emiten notas de crédito o
    // reintentan van contra `documentoDeB`, que es de hoy).
    //
    // La hora es de tarde en Lima a propósito: a las 18:00 UTC son las 13:00 en
    // Lima, así que el día de negocio es el mismo mire quien lo mire. Con una
    // hora de madrugada, UTC y Lima caerían en días distintos y la prueba
    // volvería a depender de en qué zona se hace la cuenta.
    // Va en la MISMA serie B900: solo puede haber una serie activa por tipo de
    // comprobante (índice `idx_bil_series_activa`), que es la regla que impide
    // dos correlativos en paralelo para el mismo tipo.
    await withTenant(pool, b.tenantId, ({ client }) =>
      client.query(
        `INSERT INTO bil_documents
           (tenant_id, company_id, doc_type, status,
            series_id, series, correlative, number,
            subtotal, taxable_base, tax, total, customer_name, issued_at)
         SELECT $1, $2, 'boleta', 'accepted', s.id, 'B900', 8, 'B900-00000008',
                '84.7458','84.7458','15.2542','100.0000','Cliente SECRETO de B',
                $3::timestamptz
           FROM bil_series s
          WHERE s.tenant_id = $1 AND s.series = 'B900'`,
        [b.tenantId, demoB.companyId, `${DIA_SOLO_DE_B}T18:00:00Z`],
      ),
    );

    // Conexiones de integración: el token de webhook de B identifica su canal y
    // permitiría dirigirle pedidos, así que cuenta como secreto suyo.
    const connections = app.get(ConnectionService);
    await connections.create(a.tenantId, {
      provider: SIMULATOR_PROVIDER,
      channel: 'simulador',
      brandId: demoA.brandIds[0],
      locationId: demoA.locationId,
      signingSecret: 'secreto-de-firma-del-tenant-a-iso',
    });
    const conexionB = await connections.create(b.tenantId, {
      provider: SIMULATOR_PROVIDER,
      channel: 'simulador',
      brandId: demoB.brandIds[0],
      locationId: demoB.locationId,
      signingSecret: 'secreto-de-firma-del-tenant-b-iso',
    });

    // Tiendas web de ambos: la tienda resuelve el tenant por HOST, no por
    // token, así que es la única superficie donde una confusión de dominios
    // enseñaría el catálogo y los precios de un competidor.
    const storefront = app.get(StorefrontService);
    const dominioA = await storefront.registerDomain(a.tenantId, {
      brandId: demoA.brandIds[0],
      host: HOST_ISO_A,
    });
    await storefront.verifyDomain(a.tenantId, dominioA.id);
    const dominioB = await storefront.registerDomain(b.tenantId, {
      brandId: demoB.brandIds[0],
      host: HOST_ISO_B,
    });
    await storefront.verifyDomain(b.tenantId, dominioB.id);
    dominioDeB = dominioB.id;

    // Todo lo que identifica al tenant B y jamás debe salir en la respuesta de A.
    secretsOfB = [
      b.tenantId,
      b.ownerUserId,
      demoB.companyId,
      demoB.brandIds[0],
      demoB.brandIds[1],
      demoB.locationId,
      demoB.kitchenId,
      demoB.warehouseId,
      insumoDeB,
      'Insumo SECRETO de B',
      documentoDeB,
      'B900-00000007',
      'Cliente SECRETO de B',
      demoB.zoneIds[0],
      demoB.zoneIds[1],
      demoB.scheduleId,
      ...demoB.stationIds,
      'Aislamiento Tenant B SECRETO',
      'iso-b@sahana.test',
      // Catálogo del tenant B: productos, categorías y modificadores.
      catB.categoryId,
      catB.polloId,
      catB.soloPosId,
      catB.comboId,
      catB.groupTamanoId,
      catB.groupExtrasId,
      catB.optionGrandeId,
      catB.optionQuesoId,
      // Integraciones del tenant B.
      conexionB.id,
      conexionB.webhookToken,
      'secreto-de-firma-del-tenant-b-iso',
      // Tienda del tenant B: el dominio y su host.
      dominioDeB,
      HOST_ISO_B,
    ];

    const pedido = await app.get(OrderingService).submit(a.tenantId, {
      brandId: demoA.brandIds[0],
      locationId: demoA.locationId,
      channel: 'pos',
      lines: [{ productId: catA.comboId, quantity: 1 }],
    });
    pedidoDeA = pedido.id;

    const apartado = await app
      .get(OrderingService)
      .submitForReview(a.tenantId, {
        brandId: demoA.brandIds[0],
        locationId: demoA.locationId,
        channel: 'simulador',
        externalRef: 'AISLAMIENTO-EXC-1',
        reason: 'SKU desconocido',
        rawPayload: { items: [{ sku: 'SKU-DE-A', qty: 2 }] },
        customerName: 'Cliente de A',
        customerPhone: '+51911100022',
      });
    excepcionDeA = apartado.id;

    localDeB = demoB.locationId;
    tenantIdB = b.tenantId;

    const pedidoB = await app.get(OrderingService).submit(b.tenantId, {
      brandId: demoB.brandIds[0],
      locationId: demoB.locationId,
      channel: 'pos',
      lines: [{ productId: catB.comboId, quantity: 1 }],
    });
    pedidoDeB = pedidoB.id;
    secretsOfB.push(pedidoDeB);

    // Cobro de B contra ese pedido. La `reference` entra como secreto porque
    // es con lo que vuelve el webhook de la pasarela: quien la tenga puede
    // intentar avisos contra un cobro ajeno, y aunque la firma lo pare, no
    // tiene por qué llegar a saberla.
    const pasarelaDeB = await app
      .get(PaymentsService)
      .createConnection(b.tenantId, {
        provider: CULQI_PROVIDER,
        webhookSecret: 'secreto-de-la-pasarela-del-tenant-b',
      });
    const cobroDeB = await app.get(PaymentsService).createIntent(b.tenantId, {
      orderId: pedidoDeB,
      provider: CULQI_PROVIDER,
    });
    intencionDeB = cobroDeB.id;

    const linkDeB = await app
      .get(PaymentsService)
      .createPaymentLink(b.tenantId, {
        orderId: pedidoDeB,
        provider: CULQI_PROVIDER,
      });
    enlaceDeB = linkDeB.token;

    const liquidacion = await app
      .get(SettlementsService)
      .importSettlement(b.tenantId, {
        provider: CULQI_PROVIDER,
        externalRef: 'deposito-SECRETO-de-B',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        grossAmount: '5000.0000',
        feeAmount: '750.0000',
        netAmount: '4250.0000',
        lines: [
          {
            providerRef: 'chr_SECRETO_de_B',
            grossAmount: '5000.0000',
            feeAmount: '750.0000',
            netAmount: '4250.0000',
          },
        ],
      });
    liquidacionDeB = liquidacion.id;
    secretsOfB.push(
      liquidacionDeB,
      'deposito-SECRETO-de-B',
      'chr_SECRETO_de_B',
    );

    secretsOfB.push(
      enlaceDeB,
      linkDeB.intentId,
      intencionDeB,
      cobroDeB.reference,
      pasarelaDeB.id,
      pasarelaDeB.webhookToken,
      'secreto-de-la-pasarela-del-tenant-b',
    );

    // Reparto de B: un repartidor con nombre reconocible y un envío con cobro
    // contra entrega, que es deuda de efectivo y por tanto dato sensible.
    const deliveryB = app.get(DeliveryService);
    const repartidor = await deliveryB.createCourier(b.tenantId, {
      locationId: demoB.locationId,
      fullName: 'Repartidor SECRETO de B',
      phone: '+51999000111',
    });
    repartidorDeB = repartidor.id;
    const envio = await deliveryB.createShipment(b.tenantId, {
      orderId: pedidoDeB,
      codAmountMinor: 777_000,
    });
    envioDeB = envio.id;
    const seguimiento = await deliveryB.issueTrackingLink(b.tenantId, envioDeB);
    seguimientoDeB = seguimiento.token;
    secretsOfB.push(
      repartidorDeB,
      'Repartidor SECRETO de B',
      '+51999000111',
      envioDeB,
      seguimientoDeB,
    );

    // Conversación de B con un mensaje reconocible: lo que los clientes de un
    // tenant le escriben es de lo más privado que guarda el sistema.
    const conversationsB = app.get(ConversationsService);
    const conv = await conversationsB.receiveInbound(b.tenantId, {
      brandId: demoB.brandIds[0],
      channel: 'whatsapp',
      phone: '+51999888777',
      text: 'Reclamo SECRETO de un cliente de B',
      displayName: 'Cliente que escribe a B',
    });
    conversacionDeB = conv.conversationId;
    secretsOfB.push(
      conversacionDeB,
      '+51999888777',
      'Reclamo SECRETO de un cliente de B',
      'Cliente que escribe a B',
    );

    // Fuente de conocimiento de B. El RAG busca por SIMILITUD, no por id: si el
    // filtro por tenant fallara, el material de B saldría ordenado por parecido
    // en la respuesta del agente de A, sin error y sin rastro.
    const fuente = await app.get(KnowledgeService).upsertSource(b.tenantId, {
      title: 'Receta SECRETA de B',
      body: 'El secreto de B es marinar el pollo doce horas con chicha de jora.',
    });
    fuenteDeB = fuente.id;

    // Presupuesto de IA propio de B. Sin él, A y B devolverían el mismo cero y
    // el caso de `/ai/budget` pasaría en verde sin demostrar nada: dos
    // respuestas vacías idénticas no son aislamiento, son dos tenants vacíos.
    await app.get(AgentService).setBudget(b.tenantId, 987_654);
    secretsOfB.push('987654');
    secretsOfB.push(fuenteDeB, 'Receta SECRETA de B', 'chicha de jora');

    // B necesita DATOS de analítica y mensajería: dos respuestas de ceros
    // idénticas no demuestran aislamiento, solo que ambos tenants están
    // vacíos. Con datos solo en B, cualquier fuga se ve.
    await withTenant(pool, b.tenantId, async ({ client }) => {
      await client.query(
        `INSERT INTO ana_daily_sales
           (tenant_id, business_date, brand_id, location_id, channel,
            orders, gross_revenue)
         VALUES ($1, current_date, $2, $3, 'pos', 7, 1234.5600)`,
        [b.tenantId, demoB.brandIds[0], demoB.locationId],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO wa_contacts (tenant_id, phone) VALUES ($1,'+51900000009')
         RETURNING id`,
        [b.tenantId],
      );
      await client.query(
        `INSERT INTO wa_messages
           (tenant_id, contact_id, order_id, direction, kind, template_name, status)
         VALUES ($1,$2,$3,'outbound','template','pedido_confirmado','sent')`,
        [b.tenantId, rows[0]!.id, pedidoDeB],
      );
    });

    const loginA = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'iso-a@sahana.test', password: 'password-iso-a-1' })
      .expect(201);
    tokenA = loginA.body.accessToken;

    const loginB = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'iso-b@sahana.test', password: 'password-iso-b-1' })
      .expect(201);
    tokenB = loginB.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  /** Caso base con los tokens y secretos ya resueltos. */
  const caseFor = (
    name: string,
    build: IsolationCase['request'],
    extra: Partial<IsolationCase> = {},
  ): IsolationCase => ({
    name,
    request: build,
    tokenA,
    tokenB,
    secretsOfB,
    ...extra,
  });

  it('GET /tenant', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /tenant', (r) => r.get('/api/v1/tenant')),
    );
  });

  it('GET /tenant/limits', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /tenant/limits', (r) => r.get('/api/v1/tenant/limits')),
    );
  });

  it('GET /tenant/flags', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /tenant/flags', (r) => r.get('/api/v1/tenant/flags')),
    );
  });

  it('GET /audit', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /audit', (r) => r.get('/api/v1/audit')),
    );
  });

  it('GET /audit con filtros', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /audit?entity=tenant', (r) =>
        r.get('/api/v1/audit?entity=tenant'),
      ),
    );
  });

  it('GET /organization', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /organization', (r) => r.get('/api/v1/organization')),
    );
  });

  it('GET /organization/open', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /organization/open', (r) =>
        r.get(`/api/v1/organization/open?location=${demoA.locationId}`),
      ),
    );
  });

  it('GET /coverage', async () => {
    // Ambos tenants tienen zonas con la MISMA geometría: si hubiera fuga, la
    // respuesta de A podría traer la zona de B sin que se note a simple vista.
    await assertEndpointIsolation(
      app,
      caseFor('GET /coverage', (r) =>
        r.get('/api/v1/coverage?lat=-12.12&lng=-77.02'),
      ),
    );
  });

  it('GET /devices', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /devices', (r) => r.get('/api/v1/devices')),
    );
  });

  it('GET /auth/me', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /auth/me', (r) => r.get('/api/v1/auth/me')),
    );
  });

  it('GET /health es público y no expone datos de tenant', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /health', (r) => r.get('/api/v1/health'), {
        isPublic: true,
        // No es de ningún tenant: no hay simetría que comprobar.
        tenantless: true,
      }),
    );
  });

  it('GET /health/ready es público y no expone datos de tenant', async () => {
    // La sonda que gobierna el canario. Es pública a propósito —un balanceador
    // no lleva token— así que lo único que puede decir es si ESTA instancia
    // sirve: nunca nada de ningún tenant.
    await assertEndpointIsolation(
      app,
      caseFor('GET /health/ready', (r) => r.get('/api/v1/health/ready'), {
        isPublic: true,
        tenantless: true,
      }),
    );
  });

  it('POST /devices/pairing-codes', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /devices/pairing-codes',
        (r) => r.post('/api/v1/devices/pairing-codes').send({}),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('GET /orders', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /orders', (r) => r.get('/api/v1/orders')),
    );
  });

  it('PATCH /orders/:id (pedido de A)', async () => {
    // El pedido pertenece a A: para B no existe. Se comprueba además que la
    // respuesta a B no revele NADA del pedido ajeno, ni siquiera su versión.
    await assertEndpointIsolation(
      app,
      caseFor(
        'PATCH /orders/:id',
        (r) =>
          r
            .patch(`/api/v1/orders/${pedidoDeA}`)
            .set('if-match', '1')
            .send({ lines: [{ productId: catA.comboId, quantity: 1 }] }),
        { expectedStatusForA: [200] },
      ),
    );
  });

  it('GET /orders/exceptions', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /orders/exceptions', (r) =>
        r.get('/api/v1/orders/exceptions'),
      ),
    );
  });

  it('GET /users no trae el equipo del vecino', async () => {
    // La lista lleva nombres y correos del personal: es dato personal de
    // terceros, y además el mapa de quién puede aprobar qué.
    await assertEndpointIsolation(
      app,
      caseFor('GET /users', (r) => r.get('/api/v1/users')),
    );
  });

  it('POST /users no da de alta en el tenant ajeno', async () => {
    // El peor de los dos: si escribiera cruzado, A se crearía una cuenta
    // dentro del negocio de B.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /users',
        (r) =>
          r.post('/api/v1/users').send({
            email: `alta-aislamiento-${Date.now()}@sahana.test`,
            fullName: 'Alta de prueba',
            password: 'password-aislamiento-1',
            roleCode: 'cashier',
          }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('GET /inventory/items', async () => {
    // La lista de insumos con su costo unitario es la estructura de costos del
    // negocio: quien la lea sabe con qué margen trabaja la competencia.
    await assertEndpointIsolation(
      app,
      caseFor('GET /inventory/items', (r) => r.get('/api/v1/inventory/items')),
    );
  });

  it('GET /inventory/recipes', async () => {
    // Y las recetas son literalmente el know-how: qué lleva cada plato y
    // cuánto.
    await assertEndpointIsolation(
      app,
      caseFor('GET /inventory/recipes', (r) =>
        r.get('/api/v1/inventory/recipes'),
      ),
    );
  });

  it('POST /inventory/items no escribe en el tenant ajeno', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /inventory/items',
        (r) =>
          r
            .post('/api/v1/inventory/items')
            .send({ name: 'Insumo de prueba', unit: 'g' }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('GET /inventory/movements (kardex)', async () => {
    // El kardex lleva el costo unitario de cada consumo: quien lo lea sabe
    // cuánto le cuesta a la competencia cada plato que vende.
    await assertEndpointIsolation(
      app,
      caseFor('GET /inventory/movements', (r) =>
        r.get('/api/v1/inventory/movements'),
      ),
    );
  });

  it('GET /orders/:id/detail (pedido de A)', async () => {
    // El detalle lleva las LÍNEAS y los datos del cliente: es lo más concreto
    // que se puede pedir sobre un pedido ajeno.
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /orders/:id/detail',
        (r) => r.get(`/api/v1/orders/${pedidoDeA}/detail`),
        { expectedStatusForA: [200] },
      ),
    );
  });

  it('GET /orders?search= no atraviesa el tenant', async () => {
    // El buscador nuevo es un vector clásico: basta con que la condición de
    // texto se aplique SIN la de tenant para que A encuentre a los clientes de
    // B por su teléfono.
    await assertEndpointIsolation(
      app,
      caseFor('GET /orders?search=', (r) => r.get('/api/v1/orders?search=9')),
    );
  });

  it('GET /orders/:id/exception (excepción de A)', async () => {
    // Lo que se protege aquí no es el pedido: es el payload crudo del canal,
    // con el nombre y el teléfono del cliente de la competencia dentro.
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /orders/:id/exception',
        (r) => r.get(`/api/v1/orders/${excepcionDeA}/exception`),
        { expectedStatusForA: [200] },
      ),
    );
  });

  it('GET /integrations/connections', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /integrations/connections', (r) =>
        r.get('/api/v1/integrations/connections'),
      ),
    );
  });

  it('GET /integrations/dead-letters', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /integrations/dead-letters', (r) =>
        r.get('/api/v1/integrations/dead-letters'),
      ),
    );
  });

  it('GET /ordering/acceptance-policies', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /ordering/acceptance-policies', (r) =>
        r.get('/api/v1/ordering/acceptance-policies'),
      ),
    );
  });

  it('POST /orders/sync (POS offline)', async () => {
    // El ULID de cliente es del tenant que lo manda: si el endpoint no filtrara,
    // B podría sincronizar pedidos contra la marca y el local de A.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /orders/sync',
        (r) =>
          r.post('/api/v1/orders/sync').send({
            orders: [
              {
                clientId: `01JISO${Date.now()}${Math.floor(Math.random() * 1000)}`,
                brandId: demoA.brandIds[0],
                locationId: demoA.locationId,
                channel: 'pos',
                lines: [
                  {
                    productId: catA.comboId,
                    productName: 'Combo familiar',
                    quantity: 1,
                    unitPriceMinor: 380_000,
                    lineTotalMinor: 380_000,
                  },
                ],
                totalMinor: 380_000,
              },
            ],
          }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('GET /cash-sessions', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /cash-sessions', (r) => r.get('/api/v1/cash-sessions')),
    );
  });

  it('POST /cash-sessions', async () => {
    // Cada tenant abre en SU local; si el endpoint no filtrara, A vería la
    // sesión de B o podría abrir caja en un local ajeno.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /cash-sessions',
        (r) =>
          r
            .post('/api/v1/cash-sessions')
            .send({ locationId: demoA.locationId, openingFloatMinor: 0 }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('GET /kitchen/queue', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /kitchen/queue', (r) =>
        r.get(`/api/v1/kitchen/queue?kitchen=${demoA.kitchenId}`),
      ),
    );
  });

  it('GET /kitchen/load', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /kitchen/load', (r) =>
        r.get(`/api/v1/kitchen/load?kitchen=${demoA.kitchenId}`),
      ),
    );
  });

  it('GET /inventory/stock', async () => {
    // El stock de B revelaría qué insumos maneja y en qué volumen: es
    // información de negocio, no un dato técnico.
    await assertEndpointIsolation(
      app,
      caseFor('GET /inventory/stock', (r) => r.get('/api/v1/inventory/stock')),
    );
  });

  it('GET /inventory/stock filtrando por el almacén de B', async () => {
    // El caso que de verdad importa: A pide EXPLÍCITAMENTE el almacén ajeno.
    // Debe volver vacío, nunca el stock de B.
    await assertEndpointIsolation(
      app,
      caseFor('GET /inventory/stock?warehouse=<B>', (r) =>
        r.get(`/api/v1/inventory/stock?warehouse=${almacenDeB}`),
      ),
    );
  });

  it('POST /inventory/movements sobre el almacén de B', async () => {
    // Ajustar el inventario de otro tenant sería peor que leerlo: no filtra
    // datos, los corrompe.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /inventory/movements',
        (r) =>
          r.post('/api/v1/inventory/movements').send({
            warehouseId: almacenDeB,
            itemId: insumoDeB,
            quantity: '-1.0000',
            reason: 'Intento de ajuste cruzado',
          }),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /orders/channel-pauses del local de B', async () => {
    // Saber qué canales tiene cerrados otro negocio es inteligencia
    // competitiva: dice cuándo no da abasto.
    await assertEndpointIsolation(
      app,
      caseFor('GET /orders/channel-pauses', (r) =>
        r.get(`/api/v1/orders/channel-pauses?locationId=${localDeB}`),
      ),
    );
  });

  it('POST /orders/channel-pauses sobre el local de B', async () => {
    // Cerrarle un canal a otro negocio es apagarle las ventas.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /orders/channel-pauses',
        (r) =>
          r.post('/api/v1/orders/channel-pauses').send({
            locationId: localDeB,
            channel: 'web',
            paused: true,
            reason: 'Intento cruzado',
          }),
        { expectedStatusForA: [404] },
      ),
    );

    // El arnés llama al endpoint también COMO B —así comprueba que la ruta
    // funciona para su dueño— así que aquí B se ha cerrado su propio canal.
    // Se deshace: dejarlo cerrado apagaría las ventas de B para las pruebas
    // que vienen después, y el fallo aparecería a diez pruebas de distancia.
    await app.get(OrderingService).setChannelPause(tenantIdB, {
      locationId: localDeB,
      channel: 'web',
      paused: false,
      pausedBy: 'manual',
    });
  });

  it('GET /messaging/contacts no enseña los teléfonos de B', async () => {
    // Son datos personales de los clientes de otro negocio: la lista entera de
    // a quién le vende y por qué número.
    await assertEndpointIsolation(
      app,
      caseFor('GET /messaging/contacts', (r) =>
        r.get('/api/v1/messaging/contacts'),
      ),
    );
  });

  it('GET /storefront/domains no enseña los de B', async () => {
    // El host de otro negocio dice dónde vive su tienda y con qué marca: es lo
    // que haría falta para intentar suplantarla.
    await assertEndpointIsolation(
      app,
      caseFor('GET /storefront/domains', (r) =>
        r.get('/api/v1/storefront/domains'),
      ),
    );
  });

  it('GET /documents', async () => {
    // Los comprobantes de B llevan su RUC, sus importes y sus correlativos:
    // es lo más sensible que guarda el sistema.
    await assertEndpointIsolation(
      app,
      caseFor('GET /documents', (r) => r.get('/api/v1/documents')),
    );
  });

  it('GET /documents/:id de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /documents/:id',
        (r) => r.get(`/api/v1/documents/${documentoDeB}`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('POST /documents/:id/retry sobre el comprobante de B', async () => {
    // Reenviar el comprobante de otro tenant no filtra datos: los DECLARA a
    // SUNAT en su nombre.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /documents/:id/retry',
        (r) => r.post(`/api/v1/documents/${documentoDeB}/retry`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('POST /documents/:id/correct sobre el comprobante de B', async () => {
    // Corregir el comprobante de otro tenant es reescribir a nombre de quién
    // declara una venta ajena, y además reenviarla.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /documents/:id/correct',
        (r) =>
          r
            .post(`/api/v1/documents/${documentoDeB}/correct`)
            .send({ docType: 'DNI', docNumber: '45678912' }),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('POST /documents/:id/credit-note sobre el comprobante de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /documents/:id/credit-note',
        (r) =>
          r
            .post(`/api/v1/documents/${documentoDeB}/credit-note`)
            .send({ reason: 'Intento de anulación cruzada' }),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /analytics/profitability', async () => {
    // La rentabilidad de B es su información más sensible: dice qué marcas le
    // funcionan y por qué canal.
    await assertEndpointIsolation(
      app,
      caseFor('GET /analytics/profitability', (r) =>
        r.get('/api/v1/analytics/profitability'),
      ),
    );
  });

  it('GET /analytics/reconciliation', async () => {
    // Se pide un día CONCRETO, y uno en el que solo B tiene facturación.
    //
    // Sin fecha fija, el caso preguntaba por «hoy» y dependía de dos cosas
    // frágiles: la hora a la que corre la suite y lo que las pruebas anteriores
    // le hubieran hecho al comprobante de B (`retry`, `credit-note`). Cuando el
    // resultado salía vacío para los dos tenants, el detector veía dos
    // respuestas idénticas y cantaba fuga donde no la había — y, peor, el caso
    // no comprobaba nada: un endpoint que devuelve ceros a todo el mundo no
    // puede filtrar mal.
    //
    // Con `DIA_SOLO_DE_B`, A responde ceros y B responde su facturación. Si
    // algún día coinciden, esta vez sí significa que algo se está cruzando.
    await assertEndpointIsolation(
      app,
      caseFor('GET /analytics/reconciliation', (r) =>
        r.get(`/api/v1/analytics/reconciliation?date=${DIA_SOLO_DE_B}`),
      ),
    );
  });

  it('GET /messaging/kpi', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /messaging/kpi', (r) => r.get('/api/v1/messaging/kpi')),
    );
  });

  it('GET /messaging/orders/:id/stats del pedido de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /messaging/orders/:id/stats',
        (r) => r.get(`/api/v1/messaging/orders/${pedidoDeB}/stats`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /catalog/resolved', async () => {
    // Ambos tenants tienen catálogos con la MISMA estructura y nombres: si
    // hubiera fuga, no se notaría por el contenido, solo por los ids.
    await assertEndpointIsolation(
      app,
      caseFor('GET /catalog/resolved', (r) =>
        r.get(
          `/api/v1/catalog/resolved?brand=${demoA.brandIds[0]}&channel=web`,
        ),
      ),
    );
  });

  it('GET /catalog/versions', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /catalog/versions', (r) =>
        r.get(
          `/api/v1/catalog/versions?brand=${demoA.brandIds[0]}&channel=web`,
        ),
      ),
    );
  });

  it('POST /catalog/publish', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /catalog/publish',
        (r) =>
          r
            .post('/api/v1/catalog/publish')
            .send({ brandId: demoA.brandIds[0], channel: 'web' }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('POST /catalog/products/:id/pause', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /catalog/products/:id/pause',
        (r) =>
          r
            .post(`/api/v1/catalog/products/${catA.polloId}/pause`)
            .send({ channels: ['rappi'] }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Prueba del propio detector. Un harness de seguridad que no puede fallar no
  // demuestra nada: podría estar pasando por un error en su lógica de búsqueda
  // en vez de por ausencia real de fugas. Aquí se le presenta una fuga
  // simulada —se declara como "secreto de B" un valor que SÍ está en la
  // respuesta de A— y se exige que la detecte.
  // -------------------------------------------------------------------------
  it('GET /payments/intents/:id de la intención de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /payments/intents/:id',
        (r) => r.get(`/api/v1/payments/intents/${intencionDeB}`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /payments/orders/:orderId/intents del pedido de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /payments/orders/:orderId/intents', (r) =>
        r.get(`/api/v1/payments/orders/${pedidoDeB}/intents`),
      ),
    );
  });

  it('GET /payments/refunds/stuck no enseña las de B', async () => {
    // Una lista sin parámetro es el caso donde el aislamiento se rompe sin que
    // nadie lo note: no hay un id que «no encuentre», solo filas de más.
    await assertEndpointIsolation(
      app,
      caseFor('GET /payments/refunds/stuck', (r) =>
        r.get('/api/v1/payments/refunds/stuck'),
      ),
    );
  });

  it('POST /payments/intents sobre el pedido de B', async () => {
    // El más peligroso de los tres: si colara, A podría generar un cobro contra
    // un pedido ajeno y desviar el dinero a SU pasarela.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /payments/intents',
        (r) =>
          r
            .post('/api/v1/payments/intents')
            .send({ orderId: pedidoDeB, provider: CULQI_PROVIDER }),
        { expectedStatusForA: [404, 422] },
      ),
    );
  });

  it('POST /payments/links sobre el pedido de B', async () => {
    // Si colara, A generaría un cobro contra un pedido ajeno y desviaría el
    // dinero a SU pasarela — con un enlace que además puede mandar por WhatsApp.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /payments/links',
        (r) =>
          r
            .post('/api/v1/payments/links')
            .send({ orderId: pedidoDeB, provider: CULQI_PROVIDER }),
        { expectedStatusForA: [404, 422] },
      ),
    );
  });

  it('POST /payments/intents/:id/refund sobre el cobro de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /payments/intents/:id/refund',
        (r) =>
          r
            .post(`/api/v1/payments/intents/${intencionDeB}/refund`)
            .send({ reason: 'Intento de devolver plata ajena' }),
        { expectedStatusForA: [404, 422] },
      ),
    );
  });

  it('POST /payments/links/:token/revoke del enlace de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /payments/links/:token/revoke',
        (r) => r.post(`/api/v1/payments/links/${enlaceDeB}/revoke`),
        { expectedStatusForA: [404, 204] },
      ),
    );
  });

  it('POST /payments/settlements/:id/reconcile de la liquidación de B', async () => {
    // La conciliación de B dice cuánto le cobra su pasarela: es su estructura
    // de costes, y con ella se sabe con qué margen puede competir.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /payments/settlements/:id/reconcile',
        (r) =>
          r.post(`/api/v1/payments/settlements/${liquidacionDeB}/reconcile`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('POST /storefront/domains/:id/verify del dominio de B', async () => {
    // Dar por verificado el dominio de otro es el paso previo a servir su
    // tienda: no basta con no leerlo, hay que no poder activarlo.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /storefront/domains/:id/verify',
        (r) => r.post(`/api/v1/storefront/domains/${dominioDeB}/verify`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /shop/context del host de A no trae nada de B', async () => {
    // La tienda no lleva token: el tenant sale del HOST. Es la única superficie
    // del sistema donde una confusión de dominios enseñaría la marca de otro.
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /shop/context',
        (r) => r.get('/api/v1/shop/context').set('host', HOST_ISO_A),
        {
          isPublic: true,
          requestAsB: (r) =>
            r.get('/api/v1/shop/context').set('host', HOST_ISO_B),
        },
      ),
    );
  });

  it('GET /shop/catalog del host de A no trae el catálogo de B', async () => {
    // El caso que hace vendible el producto: si el catálogo se resolviera por
    // otra cosa que el host, un competidor leería precios ajenos desde su
    // propio dominio.
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /shop/catalog',
        (r) => r.get('/api/v1/shop/catalog').set('host', HOST_ISO_A),
        {
          isPublic: true,
          requestAsB: (r) =>
            r.get('/api/v1/shop/catalog').set('host', HOST_ISO_B),
        },
      ),
    );
  });

  it('POST /shop/carts del host de A abre un carrito que no es de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /shop/carts',
        (r) => r.post('/api/v1/shop/carts').set('host', HOST_ISO_A),
        {
          isPublic: true,
          expectedStatusForA: [201],
          requestAsB: (r) =>
            r.post('/api/v1/shop/carts').set('host', HOST_ISO_B),
        },
      ),
    );
  });

  it('GET /delivery/couriers no trae los repartidores de B', async () => {
    // Los nombres y teléfonos de los repartidores de otro son datos personales
    // de terceros, no solo información de negocio.
    await assertEndpointIsolation(
      app,
      caseFor('GET /delivery/couriers', (r) =>
        r.get('/api/v1/delivery/couriers'),
      ),
    );
  });

  it('GET /delivery/shipments no trae los envíos de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /delivery/shipments', (r) =>
        r.get('/api/v1/delivery/shipments'),
      ),
    );
  });

  it('GET /delivery/shipments/:id del envío de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /delivery/shipments/:id',
        (r) => r.get(`/api/v1/delivery/shipments/${envioDeB}`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('POST /delivery/shipments/:id/assign sobre el envío de B', async () => {
    // Meterle un repartidor propio al envío de otro sería mandar a alguien a
    // una dirección que no debería conocer.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /delivery/shipments/:id/assign',
        (r) =>
          r
            .post(`/api/v1/delivery/shipments/${envioDeB}/assign`)
            .send({ courierId: demoA.locationId }),
        { expectedStatusForA: [404, 422] },
      ),
    );
  });

  it('GET /delivery/couriers/balances no trae la deuda de los de B', async () => {
    // Cuánto efectivo lleva encima cada repartidor de la competencia.
    await assertEndpointIsolation(
      app,
      caseFor('GET /delivery/couriers/balances', (r) =>
        r.get('/api/v1/delivery/couriers/balances'),
      ),
    );
  });

  it('POST /delivery/couriers/:id/settle del repartidor de B', async () => {
    // Liquidar al repartidor de otro contra la caja propia mete su efectivo en
    // el cajón equivocado: es el peor resultado posible de una fuga aquí.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /delivery/couriers/:id/settle',
        (r) =>
          r
            .post(`/api/v1/delivery/couriers/${repartidorDeB}/settle`)
            .send({ sessionId: demoA.locationId }),
        { expectedStatusForA: [200, 201, 404, 422] },
      ),
    );
  });

  it('el seguimiento público de B no dice de quién es el pedido', async () => {
    // Es público a propósito —quien compra no tiene cuenta—, así que aquí no
    // se comprueba que A no pueda abrirlo: se comprueba que abrirlo NO revele
    // de quién es. Estado, ETA y un nombre de pila; ni tenant, ni envío, ni
    // importe, ni apellido.
    const r = await request(app.getHttpServer())
      .get(`/api/v1/tracking/${seguimientoDeB}`)
      .expect(200);
    const cuerpo = JSON.stringify(r.body);
    for (const secreto of [
      envioDeB,
      'Repartidor SECRETO de B',
      '+51999000111',
    ]) {
      expect(
        cuerpo,
        `el seguimiento público filtró "${secreto}"`,
      ).not.toContain(secreto);
    }
  });

  it('GET /conversations no trae la bandeja de B', async () => {
    // Lo que los clientes de un tenant escriben —reclamos, teléfonos, nombres—
    // es de lo más privado que guarda el sistema.
    await assertEndpointIsolation(
      app,
      caseFor('GET /conversations', (r) => r.get('/api/v1/conversations')),
    );
  });

  it('GET /conversations con BÚSQUEDA no atraviesa el tenant', async () => {
    // La búsqueda por texto es el camino más fácil a una fuga: se busca por
    // contenido, no por id, así que un filtro olvidado devuelve el mensaje de
    // otro sin que ningún identificador lo delate.
    await assertEndpointIsolation(
      app,
      caseFor('GET /conversations?search', (r) =>
        r.get('/api/v1/conversations?search=SECRETO'),
      ),
    );
  });

  it('GET /conversations/:id/messages del hilo de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /conversations/:id/messages',
        (r) => r.get(`/api/v1/conversations/${conversacionDeB}/messages`),
        { expectedStatusForA: [200, 404] },
      ),
    );
  });

  it('POST /conversations/:id/messages en la conversación de B', async () => {
    // Escribirle a un cliente de otro tenant EN NOMBRE de esa marca es la peor
    // fuga posible de este módulo: no solo se ve algo ajeno, se actúa.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /conversations/:id/messages',
        (r) =>
          r
            .post(`/api/v1/conversations/${conversacionDeB}/messages`)
            .send({ kind: 'text', text: 'Mensaje intruso' }),
        { expectedStatusForA: [404, 422] },
      ),
    );
  });

  it('GET /ai/sources no trae las fuentes de B', async () => {
    // El know-how del negocio: recetas, políticas, respuestas a lo que más le
    // preguntan. Es de lo más valioso que carga un tenant en el sistema.
    await assertEndpointIsolation(
      app,
      caseFor('GET /ai/sources', (r) => r.get('/api/v1/ai/sources')),
    );
  });

  it('DELETE /ai/sources/:id de la fuente de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'DELETE /ai/sources/:id',
        (r) => r.delete(`/api/v1/ai/sources/${fuenteDeB}`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /ai/budget no revela el consumo de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /ai/budget', (r) => r.get('/api/v1/ai/budget')),
    );
  });

  it('el harness DETECTA una fuga simulada (prueba del detector)', async () => {
    const conFugaDeliberada: IsolationCase = {
      name: 'GET /organization (fuga simulada)',
      request: (r) => r.get('/api/v1/organization'),
      tokenA,
      secretsOfB: [demoA.kitchenId], // en realidad es de A: debe saltar
    };

    let detectada = false;
    try {
      await assertEndpointIsolation(app, conFugaDeliberada);
    } catch (error) {
      detectada = true;
      expect((error as Error).message).toContain('FUGA DE AISLAMIENTO');
    }
    expect(
      detectada,
      'El harness NO detectó una fuga deliberada: su lógica de búsqueda está rota ' +
        'y las demás pruebas de aislamiento no significan nada.',
    ).toBe(true);
  });

  it('el harness detecta fugas ANIDADAS en profundidad', async () => {
    // El id de una cocina vive dentro de organization.kitchens[].id — anidado
    // dos niveles. Un detector que solo mirase las claves de primer nivel no lo
    // vería.
    const anidada: IsolationCase = {
      name: 'GET /organization (fuga anidada)',
      request: (r) => r.get('/api/v1/organization'),
      tokenA,
      secretsOfB: [demoA.stationIds[0]!, demoA.companyId],
    };

    let detectada = false;
    try {
      await assertEndpointIsolation(app, anidada);
    } catch {
      detectada = true;
    }
    // companyId aparece anidado en brands[].companyId → debe detectarse.
    expect(detectada).toBe(true);
  });
});
