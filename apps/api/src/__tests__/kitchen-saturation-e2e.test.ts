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
import { KitchenService, SaturationService } from '../modules/kitchen/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Capacidad y saturación de cocina (RN-KIT-04, T5.18 — paga DT-03).
 *
 * La prueba que pide la spec 07: **la saturación dispara el evento y extiende
 * las promesas**. Y la que hace falta para poder confiar en el barrido: que
 * evaluar dos veces con la misma carga NO extienda las promesas dos veces.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Saturación de cocina', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let kitchen: KitchenService;
  let saturation: SaturationService;

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
    saturation = app.get(SaturationService);

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Saturación Tenant',
      planCode: 'growth',
      owner: {
        email: 'sat-a@sahana.test',
        password: 'password-sat-a-1',
        fullName: 'Dueña Cocina',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: org.brandIds[0]!,
        locationId: org.locationId,
      }),
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'sat-a@sahana.test', password: 'password-sat-a-1' })
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

  /** Mete `n` unidades en la cocina: pedido aceptado → tickets. */
  const cargarCocina = async (unidades: number): Promise<string> => {
    const pedido = await ordering.submit(tenantA, {
      brandId: org.brandIds[0]!,
      locationId: org.locationId,
      channel: 'web',
      lines: [
        {
          productId: cat.polloId,
          quantity: unidades,
          modifierOptionIds: [cat.optionGrandeId],
        },
      ],
    });
    await ordering.applyTransition(tenantA, pedido.id, 'accept');
    await kitchen.createTicketsForOrder(tenantA, pedido.id, {});
    return pedido.id;
  };

  const configurar = async (over: Record<string, unknown> = {}): Promise<void> => {
    await auth(http().put(`/api/v1/kitchen/capacity/${org.kitchenId}`))
      .send({
        maxConcurrentItems: 10,
        extendMinutes: 15,
        pauseThresholdItems: 20,
        channelPauseOrder: ['rappi', 'web'],
        ...over,
      })
      .expect(200);
  };

  const nivel = async (): Promise<string> => {
    const r = await auth(
      http().get(`/api/v1/kitchen/capacity?kitchen=${org.kitchenId}`),
    ).expect(200);
    return r.body.level;
  };

  it('sin configurar, la cocina no tiene límite y no se satura', async () => {
    // Un límite inventado por defecto cerraría canales en negocios que nunca
    // lo pidieron.
    const config = await auth(
      http().get(`/api/v1/kitchen/capacity?kitchen=${org.kitchenId}`),
    ).expect(200);
    expect(config.body.enabled).toBe(false);

    await cargarCocina(50);
    const r = await saturation.evaluate(tenantA, org.kitchenId);
    expect(r.level).toBe('normal');
    expect(r.ordersExtended).toBe(0);
  });

  it('rechaza una configuración que se saltaría el aviso', async () => {
    // Umbral de pausa por debajo del de saturación: la cocina pasaría de
    // normal a cerrar canales sin avisar por el camino.
    await auth(http().put(`/api/v1/kitchen/capacity/${org.kitchenId}`))
      .send({
        maxConcurrentItems: 30,
        extendMinutes: 10,
        pauseThresholdItems: 20,
        channelPauseOrder: ['web'],
      })
      .expect(422);
  });

  it('LA PRUEBA DE LA SPEC: saturación → evento + promesas extendidas', async () => {
    await limpiarCocina();
    await configurar();

    const pedido = await cargarCocina(12); // > 10 y < 20 → saturated
    const antes = await promesaDe(pedido);

    const r = await saturation.evaluate(tenantA, org.kitchenId);
    expect(r.level).toBe('saturated');
    expect(r.previousLevel).toBe('normal');
    expect(r.ordersExtended).toBeGreaterThan(0);
    // Se sigue vendiendo: saturada NO cierra canales.
    expect(r.channelsPaused).toEqual([]);

    const despues = await promesaDe(pedido);
    expect(despues.getTime() - antes.getTime()).toBe(15 * 60_000);

    // Y el evento sale por el outbox, en la misma transacción que el cambio.
    const eventos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ event_type: string }>(
        `SELECT event_type FROM outbox
          WHERE aggregate_id = $1 AND event_type = 'kitchen.saturated'`,
        [org.kitchenId],
      );
      return rows;
    });
    expect(eventos.length).toBeGreaterThan(0);
    expect(await nivel()).toBe('saturated');
  });

  it('EVALUAR DOS VECES no extiende la promesa dos veces', async () => {
    // Es lo que hace confiable el barrido de 30 s. Sin esto, una cocina
    // saturada media hora alejaría la promesa del cliente 15 min por vuelta:
    // le acabaría prometiendo la comida para el día siguiente.
    const pedido = await cargarCocina(2);
    const antes = await promesaDe(pedido);

    await saturation.evaluate(tenantA, org.kitchenId);
    await saturation.evaluate(tenantA, org.kitchenId);
    await saturation.evaluate(tenantA, org.kitchenId);

    expect((await promesaDe(pedido)).getTime()).toBe(antes.getTime());
  });

  it('CRÍTICA pausa canales, y el pedido de ese canal se RECHAZA', async () => {
    await limpiarCocina();
    await configurar();
    await cargarCocina(25); // > 20 → critical

    const r = await saturation.evaluate(tenantA, org.kitchenId);
    expect(r.level).toBe('critical');
    expect(r.channelsPaused.sort()).toEqual(['rappi', 'web']);

    // El efecto de verdad: Ordering deja de aceptar por ese canal.
    await expect(
      ordering.submit(tenantA, {
        brandId: org.brandIds[0]!,
        locationId: org.locationId,
        channel: 'web',
        lines: [
          {
            productId: cat.polloId,
            quantity: 1,
            modifierOptionIds: [cat.optionGrandeId],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CHANNEL_PAUSED' });

    // Un canal NO pausado sigue vendiendo: cerrar todo sería cerrar el local.
    const porPos = await ordering.submit(tenantA, {
      brandId: org.brandIds[0]!,
      locationId: org.locationId,
      channel: 'pos',
      lines: [
        {
          productId: cat.polloId,
          quantity: 1,
          modifierOptionIds: [cat.optionGrandeId],
        },
      ],
    });
    expect(porPos.id).toBeTruthy();
  });

  it('al bajar la carga la cocina REABRE lo que ella misma cerró', async () => {
    // Se vacía la cocina SIN evaluar: la reapertura tiene que ser el efecto de
    // esta llamada, no de la limpieza. Con `limpiarCocina()` —que ya evalúa—
    // la comprobación pasaría en verde sin demostrar nada.
    await vaciarTickets();
    const r = await saturation.evaluate(tenantA, org.kitchenId);
    expect(r.level).toBe('normal');
    expect(r.channelsResumed.sort()).toEqual(['rappi', 'web']);

    // Y vuelve a aceptar.
    const pedido = await ordering.submit(tenantA, {
      brandId: org.brandIds[0]!,
      locationId: org.locationId,
      channel: 'web',
      lines: [
        {
          productId: cat.polloId,
          quantity: 1,
          modifierOptionIds: [cat.optionGrandeId],
        },
      ],
    });
    expect(pedido.id).toBeTruthy();
  });

  it('NO reabre una pausa que puso una persona', async () => {
    // Si el encargado cerró Rappi porque se quedó sin pollo, que la cocina se
    // descongestione no significa que ya haya pollo.
    await ordering.setChannelPause(tenantA, {
      locationId: org.locationId,
      channel: 'rappi',
      paused: true,
      pausedBy: 'manual',
      reason: 'Nos quedamos sin pollo',
    });

    await limpiarCocina();
    await saturation.evaluate(tenantA, org.kitchenId);

    const pausados = await ordering.pausedChannels(tenantA, org.locationId);
    expect(pausados.map((p) => p.channel)).toContain('rappi');
    expect(pausados.find((p) => p.channel === 'rappi')?.pausedBy).toBe('manual');

    await ordering.setChannelPause(tenantA, {
      locationId: org.locationId,
      channel: 'rappi',
      paused: false,
      pausedBy: 'manual',
    });
  });

  it('el histórico registra cada cambio de nivel', async () => {
    const r = await auth(
      http().get(`/api/v1/kitchen/capacity/${org.kitchenId}/history`),
    ).expect(200);
    expect(r.body.length).toBeGreaterThan(0);
    const niveles = r.body.map((e: { toLevel: string }) => e.toLevel);
    expect(niveles).toContain('saturated');
    expect(niveles).toContain('critical');
    // Y cada fila explica por qué, para poder discutir el umbral con datos.
    expect(r.body[0].reason).toMatch(/ítems en marcha/);
  });

  it('el orden sugerido pone primero el canal de mayor comisión', async () => {
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `INSERT INTO pay_channel_tariffs
           (tenant_id, channel, percent_bps, effective_from)
         VALUES ($1,'rappi',2800, now()), ($1,'web',0, now())`,
        [tenantA],
      ),
    );
    const r = await auth(
      http().get('/api/v1/kitchen/capacity/suggested-order'),
    ).expect(200);
    expect(r.body[0]).toBe('rappi');
  });

  // ----------------------------------------------------------------- Apoyo

  /** Cierra los tickets vivos, sin evaluar. */
  async function vaciarTickets(): Promise<void> {
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE kit_tickets SET status = 'ready'
          WHERE status IN ('pending','in_progress')`,
      ),
    );
  }

  /** Vacía la cocina Y la devuelve a `normal`, para partir de un estado conocido. */
  async function limpiarCocina(): Promise<void> {
    await vaciarTickets();
    // Se fuerza una evaluación para que el nivel vuelva a `normal` y la
    // siguiente prueba parta de un estado conocido.
    await saturation.evaluate(tenantA, org.kitchenId);
  }

  async function promesaDe(orderId: string): Promise<Date> {
    return withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ promised_at: Date }>(
        'SELECT promised_at FROM ord_orders WHERE id = $1',
        [orderId],
      );
      return rows[0]!.promised_at;
    });
  }
});
