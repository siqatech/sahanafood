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
import { OrderingService } from '../modules/ordering/index.js';
import {
  KitchenService,
  KitchenEventHandlers,
  KITCHEN_CONSUMER,
} from '../modules/kitchen/index.js';
import { consumeEvent } from '../events/consumer.js';
import { relayOnce } from '../events/outbox.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Cocina / KDS (spec 07, T4.16).
 *
 * Es la primera suite en la que el pedido llega a alguien: hasta ahora todo el
 * flujo terminaba en un estado de base de datos que nadie miraba. Se ejercita
 * el camino COMPLETO —pedido → outbox → relay → consumidor → ticket— y no un
 * atajo, porque el eslabón que suele romperse es justamente ese.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Cocina / KDS', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let brandId = '';
  let marcaDosId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let kitchen: KitchenService;
  let handlers: Record<string, unknown>;

  /** Estaciones de la semilla: Parrilla, Frituras, Armado y empaque. */
  let parrillaId = '';
  let frituraId = '';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
    ordering = app.get(OrderingService);
    kitchen = app.get(KitchenService);
    handlers = app.get(KitchenEventHandlers).handlers() as Record<
      string,
      unknown
    >;

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Cocina Tenant',
      planCode: 'growth',
      owner: {
        email: 'kds-a@sahana.test',
        password: 'password-kds-a-1',
        fullName: 'Dueño Cocina',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0];
    marcaDosId = org.brandIds[1];
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    // Se da tipo a las estaciones y se enruta el catálogo: el pollo a la
    // parrilla, la bebida a frituras (para forzar dos estaciones distintas).
    await withTenant(pool, tenantA, async ({ client }) => {
      await client.query(
        "UPDATE org_stations SET kind = 'grill' WHERE id = $1",
        [org.stationIds[0]],
      );
      await client.query("UPDATE org_stations SET kind = 'fry' WHERE id = $1", [
        org.stationIds[1],
      ]);
      await client.query(
        "UPDATE cat_products SET station_kind = 'grill' WHERE id = $1",
        [cat.polloId],
      );
      await client.query(
        "UPDATE cat_products SET station_kind = 'fry' WHERE id = $1",
        [cat.comboId],
      );
    });
    parrillaId = org.stationIds[0]!;
    frituraId = org.stationIds[1]!;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'kds-a@sahana.test', password: 'password-kds-a-1' })
      .expect(201);
    tokenA = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokenA}`);

  /** Pedido con líneas de dos estaciones distintas. */
  const pedidoDosEstaciones = () =>
    ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [
        {
          productId: cat.polloId,
          quantity: 1,
          modifierOptionIds: [cat.optionGrandeId],
        },
        { productId: cat.comboId, quantity: 2 },
      ],
    });

  const aceptar = (orderId: string) =>
    ordering.applyTransition(tenantA, orderId, 'accept', {
      actorType: 'system',
    });

  /**
   * Drena el outbox por el camino REAL: relay → consumidor con inbox. No se
   * llama a `createTicketsForOrder` directamente porque lo que hay que probar
   * es justamente que el evento llega.
   */
  const drenarEventos = async (): Promise<number> => {
    let aplicados = 0;
    for (let vuelta = 0; vuelta < 6; vuelta++) {
      const entregados: Array<Record<string, unknown>> = [];
      const publicados = await relayOnce(
        pool,
        async (evento) => {
          entregados.push({
            eventId: evento.id,
            tenantId: evento.tenantId,
            aggregateId: evento.aggregateId,
            eventType: evento.eventType,
            payload: evento.payload,
            traceId: evento.traceId,
          });
        },
        100,
      );
      for (const mensaje of entregados) {
        const r = await consumeEvent(
          {
            pool,
            consumer: KITCHEN_CONSUMER,
            handlers: handlers as never,
          },
          mensaje as never,
        );
        if (r === 'processed') aplicados++;
      }
      // Los handlers generan eventos nuevos (ticket_started, order_ready), así
      // que se sigue drenando hasta que no queda nada.
      if (publicados === 0) break;
    }
    return aplicados;
  };

  // ------------------------------------------- Creación de tickets (RN-KIT-01)

  it('aceptar un pedido crea UN TICKET POR ESTACIÓN por el camino de eventos', async () => {
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);

    // Antes de drenar no hay nada: el ticket nace del evento, no del submit.
    expect(await kitchen.ticketsForOrder(tenantA, pedido.id)).toEqual([]);

    await drenarEventos();

    const tickets = await kitchen.ticketsForOrder(tenantA, pedido.id);
    expect(tickets).toHaveLength(2);
    expect(new Set(tickets.map((t) => t.stationId))).toEqual(
      new Set([parrillaId, frituraId]),
    );
  });

  it('cada estación ve SOLO sus líneas', async () => {
    // El de la parrilla no necesita ver las bebidas; que las vea es el trabajo
    // manual que el KDS existe para quitar.
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);
    await drenarEventos();

    const tickets = await kitchen.ticketsForOrder(tenantA, pedido.id);
    const parrilla = tickets.find((t) => t.stationId === parrillaId)!;
    const fritura = tickets.find((t) => t.stationId === frituraId)!;

    expect(parrilla.lines.map((l) => l.productName)).toEqual([
      'Pollo a la brasa entero',
    ]);
    expect(fritura.lines.map((l) => l.productName)).toEqual([
      'Combo familiar',
    ]);
  });

  it('los modificadores llegan en TEXTO, no en identificadores', async () => {
    // A las 21:00 con veinte pedidos encima, nadie interpreta uuids.
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);
    await drenarEventos();

    const tickets = await kitchen.ticketsForOrder(tenantA, pedido.id);
    const parrilla = tickets.find((t) => t.stationId === parrillaId)!;
    expect(parrilla.lines[0]!.modifiersText).toBe('Grande');
  });

  it('IDEMPOTENTE: una entrega repetida no duplica tickets', async () => {
    // El relay es at-least-once; dos tickets del mismo pedido en la misma
    // pantalla significan comida cocinada dos veces.
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);
    await drenarEventos();

    const antes = await kitchen.ticketsForOrder(tenantA, pedido.id);
    // Se fuerza la reentrega llamando otra vez al servicio, que es lo que hace
    // el handler cuando el evento vuelve a llegar.
    const repetido = await kitchen.createTicketsForOrder(tenantA, pedido.id);
    expect(repetido.alreadyExisted).toBe(true);

    const despues = await kitchen.ticketsForOrder(tenantA, pedido.id);
    expect(despues).toHaveLength(antes.length);

    const lineas = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM kit_ticket_lines l
           JOIN kit_tickets t ON t.id = l.ticket_id
          WHERE t.order_id = $1`,
        [pedido.id],
      );
      return Number(rows[0]!.count);
    });
    expect(lineas, 'se duplicaron las líneas del ticket').toBe(2);
  });

  it('el inbox descarta la SEGUNDA entrega del mismo evento', async () => {
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);

    const entregados: Array<Record<string, unknown>> = [];
    await relayOnce(
      pool,
      async (e) => {
        entregados.push({
          eventId: e.id,
          tenantId: e.tenantId,
          aggregateId: e.aggregateId,
          eventType: e.eventType,
          payload: e.payload,
          traceId: e.traceId,
        });
      },
      100,
    );
    const accepted = entregados.find(
      (e) => e.eventType === 'order.accepted' && e.aggregateId === pedido.id,
    )!;

    const opciones = {
      pool,
      consumer: KITCHEN_CONSUMER,
      handlers: handlers as never,
    };
    expect(await consumeEvent(opciones, accepted as never)).toBe('processed');
    expect(
      await consumeEvent(opciones, accepted as never),
      'la segunda entrega volvió a aplicarse: el inbox no está protegiendo',
    ).toBe('skipped');
  });

  // ------------------------------------------ Avance del pedido (RN-KIT-02)

  it('el pedido pasa a ready SOLO cuando TODOS los tickets están listos', async () => {
    // Si cada estación pudiera declarar el pedido listo, saldría a reparto sin
    // las papas.
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);
    await drenarEventos();

    const tickets = await kitchen.ticketsForOrder(tenantA, pedido.id);
    expect(tickets).toHaveLength(2);

    await kitchen.startTicket(tenantA, tickets[0]!.id);
    await drenarEventos();
    // El primer ticket arrancado mete el pedido en preparación.
    expect((await ordering.getSummary(tenantA, pedido.id)).status).toBe(
      'preparing',
    );

    const primero = await kitchen.readyTicket(tenantA, tickets[0]!.id);
    expect(primero.orderReady).toBe(false);
    await drenarEventos();
    expect(
      (await ordering.getSummary(tenantA, pedido.id)).status,
      'el pedido se declaró listo con una estación todavía trabajando',
    ).toBe('preparing');

    await kitchen.startTicket(tenantA, tickets[1]!.id);
    const segundo = await kitchen.readyTicket(tenantA, tickets[1]!.id);
    expect(segundo.orderReady).toBe(true);
    await drenarEventos();
    expect((await ordering.getSummary(tenantA, pedido.id)).status).toBe(
      'ready',
    );
  });

  it('un ticket no puede saltar de pendiente a listo', async () => {
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);
    await drenarEventos();
    const [ticket] = await kitchen.ticketsForOrder(tenantA, pedido.id);

    const res = await auth(
      http().post(`/api/v1/kitchen/tickets/${ticket!.id}/ready`),
    ).expect(409);
    expect(res.body.code).toBe('TICKET_INVALID_TRANSITION');
  });

  it('terminar dos veces el mismo ticket se rechaza', async () => {
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);
    await drenarEventos();
    const [ticket] = await kitchen.ticketsForOrder(tenantA, pedido.id);

    await kitchen.startTicket(tenantA, ticket!.id);
    await kitchen.readyTicket(tenantA, ticket!.id);
    await expect(kitchen.readyTicket(tenantA, ticket!.id)).rejects.toThrow(
      /no puede pasar/,
    );
  });

  // -------------------------------------------------- Cola y carga del KDS

  it('la cola se ordena por COMPROMISO, no por hora de llegada', async () => {
    // Un programado que entra tarde puede ser lo más urgente de la pantalla.
    const cola = await auth(
      http().get(`/api/v1/kitchen/queue?station=${parrillaId}`),
    ).expect(200);

    const promesas = (cola.body as Array<{ promisedAt: string | null }>)
      .map((t) => t.promisedAt)
      .filter((p): p is string => p !== null);
    const ordenadas = [...promesas].sort();
    expect(promesas).toEqual(ordenadas);
  });

  it('la cola marca los tickets atrasados y su espera', async () => {
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);
    await drenarEventos();

    // Se fuerza un compromiso ya vencido.
    await withTenant(pool, tenantA, async ({ client }) => {
      await client.query(
        "UPDATE kit_tickets SET promised_at = now() - interval '20 minutes' WHERE order_id = $1",
        [pedido.id],
      );
    });

    const cola = await kitchen.queue(tenantA, { stationId: parrillaId });
    const suyo = cola.find((t) => t.orderId === pedido.id);
    expect(suyo!.late).toBe(true);
    expect(suyo!.waitingMinutes).toBeGreaterThanOrEqual(0);
  });

  it('GET /kitchen/load resume la carga por estación', async () => {
    const res = await auth(
      http().get(`/api/v1/kitchen/load?kitchen=${org.kitchenId}`),
    ).expect(200);

    expect(res.body.activeTickets).toBeGreaterThan(0);
    expect(res.body.activeItems).toBeGreaterThanOrEqual(
      res.body.activeTickets,
    );
    expect(res.body.byStation.length).toBeGreaterThan(0);
    expect(res.body.byStation[0]).toHaveProperty('oldestWaitingMinutes');
  });

  // ------------------------------------------------- Empaque (RN-KIT-03)

  it('el empaque EXIGE verificar todas las líneas', async () => {
    // Mandar el pedido incompleto cuesta el pedido, el reparto y la
    // reputación: es el fallo más caro y más frecuente del delivery.
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);
    await drenarEventos();
    for (const t of await kitchen.ticketsForOrder(tenantA, pedido.id)) {
      await kitchen.startTicket(tenantA, t.id);
      await kitchen.readyTicket(tenantA, t.id);
    }
    await drenarEventos();

    const lineas = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM ord_order_lines WHERE order_id = $1 AND is_adjustment = false',
        [pedido.id],
      );
      return rows.map((r) => r.id);
    });

    const incompleto = await auth(
      http()
        .post(`/api/v1/kitchen/orders/${pedido.id}/pack`)
        .send({ checkedLineIds: [lineas[0]] }),
    ).expect(422);
    expect(incompleto.body.code).toBe('PACK_CHECKLIST_INCOMPLETE');
    expect(incompleto.body.missingLineIds).toHaveLength(lineas.length - 1);

    const completo = await auth(
      http()
        .post(`/api/v1/kitchen/orders/${pedido.id}/pack`)
        .send({ checkedLineIds: lineas }),
    ).expect(201);
    expect(completo.body.lines).toBe(lineas.length);
  });

  it('no se empaca un pedido con tickets sin terminar', async () => {
    const pedido = await pedidoDosEstaciones();
    await aceptar(pedido.id);
    await drenarEventos();

    const lineas = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM ord_order_lines WHERE order_id = $1 AND is_adjustment = false',
        [pedido.id],
      );
      return rows.map((r) => r.id);
    });

    const res = await auth(
      http()
        .post(`/api/v1/kitchen/orders/${pedido.id}/pack`)
        .send({ checkedLineIds: lineas }),
    ).expect(409);
    expect(res.body.code).toBe('ORDER_NOT_READY');
  });

  it('LA ETIQUETA LLEVA LA MARCA CORRECTA con dos marcas simultáneas', async () => {
    // En un local multimarca, etiquetar con la marca equivocada es un error
    // que el cliente ve. Se preparan dos pedidos a la vez, uno de cada marca.
    const catDos = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: marcaDosId,
        locationId: org.locationId,
      }),
    );

    const deMarcaUno = await ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [{ productId: cat.comboId, quantity: 1 }],
    });
    const deMarcaDos = await ordering.submit(tenantA, {
      brandId: marcaDosId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [{ productId: catDos.comboId, quantity: 1 }],
    });

    await aceptar(deMarcaUno.id);
    await aceptar(deMarcaDos.id);
    await drenarEventos();

    for (const pedidoId of [deMarcaUno.id, deMarcaDos.id]) {
      for (const t of await kitchen.ticketsForOrder(tenantA, pedidoId)) {
        await kitchen.startTicket(tenantA, t.id);
        await kitchen.readyTicket(tenantA, t.id);
      }
    }
    await drenarEventos();

    const empacar = async (pedidoId: string) => {
      const lineas = await withTenant(pool, tenantA, async ({ client }) => {
        const { rows } = await client.query<{ id: string }>(
          'SELECT id FROM ord_order_lines WHERE order_id = $1 AND is_adjustment = false',
          [pedidoId],
        );
        return rows.map((r) => r.id);
      });
      return kitchen.packOrder(tenantA, pedidoId, { checkedLineIds: lineas });
    };

    const etiquetaUno = await empacar(deMarcaUno.id);
    const etiquetaDos = await empacar(deMarcaDos.id);

    expect(etiquetaUno.brandId).toBe(brandId);
    expect(etiquetaDos.brandId).toBe(marcaDosId);
    expect(
      etiquetaUno.brandName,
      'las dos etiquetas salieron con la misma marca',
    ).not.toBe(etiquetaDos.brandName);

    // Y los tickets de cada pedido llevan su propia marca, no la del otro.
    const ticketsUno = await kitchen.ticketsForOrder(tenantA, deMarcaUno.id);
    expect(ticketsUno.every((t) => t.brandId === brandId)).toBe(true);
  });

  // ------------------------------------------------------- SLO (spec 07)

  it('SLO: de aceptado a visible en cocina en menos de 5 s', async () => {
    // El criterio de aceptación de la spec 07. Se mide el camino completo
    // —transición, outbox, relay, consumidor, ticket consultable— porque es lo
    // que de verdad tarda; medir solo la inserción diría poco.
    const pedido = await pedidoDosEstaciones();

    const t0 = process.hrtime.bigint();
    await aceptar(pedido.id);
    await drenarEventos();
    const tickets = await kitchen.queue(tenantA, {
      kitchenId: org.kitchenId,
    });
    const segundos = Number(process.hrtime.bigint() - t0) / 1e9;

    expect(tickets.some((t) => t.orderId === pedido.id)).toBe(true);
    expect(
      segundos,
      `el pedido tardó ${segundos.toFixed(2)} s en aparecer en cocina (SLO: 5 s)`,
    ).toBeLessThan(5);
  });

  it('un pedido rechazado nunca llega a cocina', async () => {
    const pedido = await pedidoDosEstaciones();
    await ordering.applyTransition(tenantA, pedido.id, 'reject', {
      actorType: 'system',
      reason: 'Prueba',
    });
    await drenarEventos();
    expect(await kitchen.ticketsForOrder(tenantA, pedido.id)).toEqual([]);
  });
});
