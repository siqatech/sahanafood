import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { consumeEvent } from '../events/consumer.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import {
  seedDemoCatalog,
  CatalogService,
  CatalogPublicationService,
} from '../modules/catalog/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import {
  ConnectionService,
  IngestionService,
  IntegrationsEventHandlers,
  INTEGRATIONS_CONSUMER,
  SIMULATOR_PROVIDER,
  SimulatorConnector,
} from '../modules/integrations/index.js';
import type { DomainEventMessage } from '../modules/kitchen/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * La mitad SALIENTE de la plataforma de integraciones (spec 13, RN-INT-05).
 *
 * Estaba escrita y no la llamaba nadie. Estas pruebas existen para que eso no
 * pueda volver a pasar en silencio: cada una parte de un hecho de negocio real
 * —se agota un plato, se publica una carta, se acepta o se cancela un pedido—
 * y **recorre el camino completo**: el servicio escribe su evento en `outbox`,
 * el evento se consume por la ruta de verdad (`consumeEvent`, con su marca de
 * `inbox`) y se comprueba que el conector recibió la llamada.
 *
 * Comprobar el servicio a solas no habría detectado el fallo original, porque
 * el servicio estaba bien: lo que faltaba era el consumidor entre medias.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const CANAL = 'simulador';
const SECRETO = 'secreto-de-firma-de-salida-x';
const SKU_POLLO = 'SIM-POLLO';
/** Da igual quién pausa: lo que se prueba es la salida, no la auditoría. */
const ACTOR = '00000000-0000-0000-0000-0000000000a1';

suite('Integraciones e2e — propagación saliente a los canales', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenant = '';
  let otroTenant = '';
  let conexionId = '';
  let handlers: Record<
    string,
    (ctx: never, event: DomainEventMessage) => Promise<void>
  >;
  let simulador: SimulatorConnector;
  let catalogo: CatalogService;
  let publicacion: CatalogPublicationService;
  let ordering: OrderingService;
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let carta: Awaited<ReturnType<typeof seedDemoCatalog>>;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();

    catalogo = app.get(CatalogService);
    publicacion = app.get(CatalogPublicationService);
    ordering = app.get(OrderingService);
    handlers = app.get(IntegrationsEventHandlers).handlers() as typeof handlers;
    simulador = app
      .get(IngestionService)
      .connectorFor(SIMULATOR_PROVIDER) as SimulatorConnector;

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const t = await tenancy.provisionTenant({
      name: 'Salida Tenant',
      planCode: 'growth',
      owner: {
        email: 'salida@sahana.test',
        password: 'password-salida-1',
        fullName: 'Dueño Salida',
      },
    });
    tenant = t.tenantId;
    created.push(tenant);

    const otro = await tenancy.provisionTenant({
      name: 'Salida Tenant Vecino',
      planCode: 'growth',
      owner: {
        email: 'salida-vecino@sahana.test',
        password: 'password-salida-2',
        fullName: 'Dueño Vecino',
      },
    });
    otroTenant = otro.tenantId;
    created.push(otroTenant);

    org = await withTenant(pool, tenant, (ctx) => seedDemoOrganization(ctx));
    carta = await withTenant(pool, tenant, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: org.brandIds[0]!,
        locationId: org.locationId,
      }),
    );

    const conexiones = app.get(ConnectionService);
    const c = await conexiones.create(tenant, {
      provider: SIMULATOR_PROVIDER,
      channel: CANAL,
      brandId: org.brandIds[0]!,
      locationId: org.locationId,
      signingSecret: SECRETO,
    });
    conexionId = c.id;

    await conexiones.mapSku(tenant, {
      connectionId: conexionId,
      externalSku: SKU_POLLO,
      productId: carta.polloId,
    });
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  beforeEach(() => {
    simulador.outbound.length = 0;
  });

  /**
   * Consume por la ruta REAL el último evento de ese tipo que dejó el servicio
   * en `outbox`. No se fabrica el evento a mano: si mañana alguien cambia el
   * payload que emite el catálogo, esta prueba se entera.
   */
  const consumirUltimo = async (
    tenantId: string,
    eventType: string,
  ): Promise<void> => {
    const evento = await withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id, aggregate_id, payload FROM outbox
          WHERE event_type = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [eventType],
      );
      return rows[0];
    });
    expect(evento, `no se emitió ningún ${eventType}`).toBeDefined();

    const resultado = await consumeEvent(
      { pool, consumer: INTEGRATIONS_CONSUMER, handlers: handlers as never },
      {
        eventId: evento!.id,
        tenantId,
        aggregateId: evento!.aggregate_id,
        eventType,
        payload: evento!.payload,
      },
    );
    expect(resultado).toBe('processed');
  };

  const ops = (op: string): unknown[] =>
    simulador.outbound.filter((o) => o.op === op).map((o) => o.data);

  // ------------------------------------------------------- Disponibilidad

  it('pausar un producto lo marca NO disponible en el canal (RN-INT-05)', async () => {
    // El fallo que esto vigila: el plato se agota, se pausa en Sahana, y el
    // marketplace lo sigue vendiendo porque nadie se lo dijo.
    await catalogo.pauseProduct(tenant, carta.polloId, {
      channels: [CANAL],
      reason: 'Sin insumo',
      actorId: ACTOR,
    });
    await consumirUltimo(tenant, 'catalog.availability_changed');

    expect(ops('setAvailability')).toEqual([
      [{ externalSku: SKU_POLLO, available: false }],
    ]);
  });

  it('reactivarlo lo vuelve a poner disponible', async () => {
    await catalogo.resumeProduct(tenant, carta.polloId, {
      channels: [CANAL],
      actorId: ACTOR,
    });
    await consumirUltimo(tenant, 'catalog.availability_changed');

    expect(ops('setAvailability')).toEqual([
      [{ externalSku: SKU_POLLO, available: true }],
    ]);
  });

  it('un producto SIN mapeo en la conexión no se envía', async () => {
    // Mandar un SKU que el canal no conoce es un error garantizado por cada
    // pausa; el combo no está mapeado en esta conexión.
    await catalogo.pauseProduct(tenant, carta.comboId, {
      channels: [CANAL],
      actorId: ACTOR,
    });
    await consumirUltimo(tenant, 'catalog.availability_changed');

    expect(simulador.outbound).toEqual([]);

    // Se despausa: más abajo se venden combos por este canal, y un producto
    // pausado no se puede pedir.
    await catalogo.resumeProduct(tenant, carta.comboId, {
      channels: [CANAL],
      actorId: ACTOR,
    });
  });

  it('una pausa en un canal SIN conexión no llama a nadie', async () => {
    await catalogo.pauseProduct(tenant, carta.polloId, {
      channels: ['canal-que-no-existe'],
      actorId: ACTOR,
    });
    await consumirUltimo(tenant, 'catalog.availability_changed');

    expect(simulador.outbound).toEqual([]);
  });

  // ---------------------------------------------------------------- Menú

  it('publicar la carta la envía al canal con su número de versión', async () => {
    const v = await publicacion.publish(tenant, {
      brandId: org.brandIds[0]!,
      channel: CANAL,
    });
    await consumirUltimo(tenant, 'catalog.published');

    const enviados = ops('pushMenu') as Array<{
      catalogVersion: string;
      menu: { products: unknown[] };
    }>;
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.catalogVersion).toBe(String(v.version));
    // Y va la instantánea aprobada, no una resolución fresca del catálogo.
    expect(enviados[0]!.menu.products.length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------ Estado del pedido

  const pedidoExterno = async (): Promise<string> => {
    const pedido = await ordering.submit(tenant, {
      brandId: org.brandIds[0]!,
      locationId: org.locationId,
      channel: CANAL,
      externalRef: `EXT-${Date.now()}`,
      // El combo no arrastra modificadores obligatorios: aquí se prueba la
      // salida, no la validación del carrito.
      lines: [{ productId: carta.comboId, quantity: 1 }],
      customerName: 'Cliente del canal',
    });
    return pedido.id;
  };

  it('aceptar un pedido del canal se lo comunica al canal', async () => {
    const orderId = await pedidoExterno();
    await ordering.applyTransition(tenant, orderId, 'accept', {
      actorType: 'system',
    });
    await consumirUltimo(tenant, 'order.accepted');

    expect(ops('updateOrderStatus')).toHaveLength(1);
    expect((ops('updateOrderStatus')[0] as { status: string }).status).toBe(
      'accepted',
    );
  });

  it('una cancelación se comunica Y se acusa con cancelAck', async () => {
    // Sin el acuse, varios canales dejan el pedido «cancelándose» para siempre
    // en su propio panel.
    const orderId = await pedidoExterno();
    await ordering.applyTransition(tenant, orderId, 'cancel', {
      actorType: 'system',
      reason: 'Local cerrado',
    });
    await consumirUltimo(tenant, 'order.cancelled');

    expect(ops('updateOrderStatus')).toHaveLength(1);
    expect(ops('cancelAck')).toHaveLength(1);
  });

  it('un pedido SIN referencia externa no genera ninguna llamada', async () => {
    // El mostrador y la tienda propia no tienen canal al que avisar. Llamar con
    // una referencia vacía sería un fallo garantizado por cada venta.
    const pedido = await ordering.submit(tenant, {
      brandId: org.brandIds[0]!,
      locationId: org.locationId,
      channel: 'pos',
      lines: [{ productId: carta.comboId, quantity: 1 }],
    });
    await ordering.applyTransition(tenant, pedido.id, 'accept', {
      actorType: 'system',
    });
    await consumirUltimo(tenant, 'order.accepted');

    expect(simulador.outbound).toEqual([]);
  });

  // ---------------------------------------------------------- Aislamiento

  it('el evento de un tenant NUNCA llega a la conexión de otro', async () => {
    // La conexión y el mapa viven bajo RLS: un evento del vecino no puede
    // encontrar el SKU de este tenant ni al revés. Es la garantía de que una
    // pausa de un competidor no despublica nuestros platos.
    const orgVecino = await withTenant(pool, otroTenant, (ctx) =>
      seedDemoOrganization(ctx),
    );
    const cartaVecina = await withTenant(pool, otroTenant, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: orgVecino.brandIds[0]!,
        locationId: orgVecino.locationId,
      }),
    );

    await catalogo.pauseProduct(otroTenant, cartaVecina.polloId, {
      channels: [CANAL],
      actorId: ACTOR,
    });
    await consumirUltimo(otroTenant, 'catalog.availability_changed');

    expect(simulador.outbound).toEqual([]);
  });

  // -------------------------------------------------------- Cortacircuitos

  it('con el cortacircuitos ABIERTO no se machaca al proveedor', async () => {
    // El circuito lo abre la ingesta cuando el proveedor lleva varios fallos
    // seguidos. Seguir empujándole menús y pausas no arregla nada y retrasa su
    // recuperación (RN-INT-03).
    await withTenant(pool, tenant, ({ client }) =>
      client.query(
        `UPDATE int_connections
            SET consecutive_failures = 99, circuit_opened_at = now()
          WHERE id = $1`,
        [conexionId],
      ),
    );

    await catalogo.pauseProduct(tenant, carta.polloId, {
      channels: [CANAL],
      actorId: ACTOR,
    });
    await consumirUltimo(tenant, 'catalog.availability_changed');

    expect(simulador.outbound).toEqual([]);

    // Y al cerrarse vuelve a propagar: el circuito pausa, no desconecta.
    await withTenant(pool, tenant, ({ client }) =>
      client.query(
        `UPDATE int_connections
            SET consecutive_failures = 0, circuit_opened_at = NULL
          WHERE id = $1`,
        [conexionId],
      ),
    );
    await catalogo.resumeProduct(tenant, carta.polloId, {
      channels: [CANAL],
      actorId: ACTOR,
    });
    await consumirUltimo(tenant, 'catalog.availability_changed');

    expect(ops('setAvailability')).toHaveLength(1);
  });

  // ---------------------------------------- Una conexión pausada no recibe

  it('una conexión pausada deja de recibir (RN-INT-03)', async () => {
    await app.get(ConnectionService).setStatus(tenant, conexionId, 'paused');

    await catalogo.pauseProduct(tenant, carta.polloId, {
      channels: [CANAL],
      actorId: ACTOR,
    });
    await consumirUltimo(tenant, 'catalog.availability_changed');

    expect(simulador.outbound).toEqual([]);

    await app.get(ConnectionService).setStatus(tenant, conexionId, 'active');
  });
});
