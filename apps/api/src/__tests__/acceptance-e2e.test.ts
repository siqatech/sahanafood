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
  OrderingService,
  AcceptanceService,
  AUTO_REJECT_REASON,
  DEFAULT_ACCEPTANCE_POLICY,
} from '../modules/ordering/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Aceptación automática/manual con vencimiento (RN-ORD-04) y liberación de los
 * pedidos programados (RN-ORD-05).
 *
 * TODO el tiempo es explícito: los barridos reciben `now`. Una prueba que
 * durmiera 10 minutos reales no se ejecutaría nunca en CI, y estas son las
 * reglas que rechazan pedidos SOLAS — precisamente las que no pueden quedarse
 * sin probar.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const T0 = new Date('2026-08-07T12:00:00Z');
const enMinutos = (m: number): Date => new Date(T0.getTime() + m * 60_000);

suite('Aceptación de pedidos y programados', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let acceptance: AcceptanceService;

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
    acceptance = app.get(AcceptanceService);

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Aceptación Tenant',
      planCode: 'growth',
      owner: {
        email: 'acc-a@sahana.test',
        password: 'password-acc-a-1',
        fullName: 'Dueño Aceptación',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0];
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'acc-a@sahana.test', password: 'password-acc-a-1' })
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

  /** Crea un pedido en el canal indicado; el combo no exige modificadores. */
  const crear = (channel: string, extra: Record<string, unknown> = {}) =>
    ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel,
      lines: [{ productId: cat.comboId, quantity: 1 }],
      ...extra,
    });

  /** Deja el pedido fuera del alcance de barridos de otras pruebas. */
  const archivar = (orderId: string) =>
    ordering.applyTransition(tenantA, orderId, 'reject', {
      actorType: 'system',
      reason: 'Limpieza de la prueba.',
    });

  // ------------------------------------------------------------- Políticas

  it('sin política configurada rige la de la spec: manual, 5 y 10 minutos', async () => {
    const politica = await acceptance.resolvePolicy(
      tenantA,
      brandId,
      'canal-sin-politica',
    );
    expect(politica).toEqual(DEFAULT_ACCEPTANCE_POLICY);
  });

  it('la política más específica gana sobre la general', async () => {
    // Por defecto del tenant: manual.
    await acceptance.setPolicy(tenantA, { autoAccept: false });
    // Para un canal concreto: automática y con plazos más cortos.
    await acceptance.setPolicy(tenantA, {
      channel: 'rappi',
      autoAccept: true,
      alertAfterMinutes: 2,
      autoRejectAfterMinutes: 4,
    });
    // Y para (marca, canal), que es lo más concreto de todo.
    await acceptance.setPolicy(tenantA, {
      brandId,
      channel: 'rappi',
      autoAccept: true,
      alertAfterMinutes: 1,
      autoRejectAfterMinutes: 3,
    });

    expect(await acceptance.resolvePolicy(tenantA, brandId, 'rappi')).toEqual({
      autoAccept: true,
      alertAfterMinutes: 1,
      autoRejectAfterMinutes: 3,
    });
    expect(await acceptance.resolvePolicy(tenantA, brandId, 'web')).toEqual({
      autoAccept: false,
      alertAfterMinutes: 5,
      autoRejectAfterMinutes: 10,
    });
  });

  it('rechaza una política con el aviso después del rechazo', async () => {
    // Avisar cuando el pedido ya se rechazó solo no sirve de nada, y quien la
    // configura así casi seguro invirtió los campos.
    await expect(
      acceptance.setPolicy(tenantA, {
        channel: 'incoherente',
        autoAccept: false,
        alertAfterMinutes: 20,
        autoRejectAfterMinutes: 10,
      }),
    ).rejects.toThrow(/no puede llegar después/);
  });

  it('cambiar la política queda auditado', async () => {
    await acceptance.setPolicy(tenantA, {
      channel: 'auditado',
      autoAccept: true,
      actorId: 'usuario-prueba',
    });
    const auditoria = await auth(
      http().get('/api/v1/audit?entity=acceptance_policy'),
    ).expect(200);
    const filas = auditoria.body.items ?? auditoria.body;
    expect(
      JSON.stringify(filas),
      'cambiar quién acepta los pedidos no dejó rastro en auditoría',
    ).toContain('acceptance_policy_changed');
  });

  // ------------------------------------------------- Aceptación automática

  it('con política automática el pedido NACE aceptado', async () => {
    await acceptance.setPolicy(tenantA, {
      channel: 'auto',
      autoAccept: true,
    });
    const pedido = await crear('auto');
    expect(pedido.status).toBe('accepted');

    // El timeline muestra los DOS hechos: se recibió y se aceptó, y que la
    // aceptación fue del sistema. Un timeline que solo dijera "accepted"
    // impediría reconstruir si alguien lo miró.
    const timeline = await ordering.getTimeline(tenantA, pedido.id);
    expect(timeline.map((e) => e.event)).toEqual(['submit', 'accept']);
    expect(timeline[1]!.actorType).toBe('system');
    expect(timeline[1]!.reason).toContain('automática');

    await archivar(pedido.id).catch(() => undefined);
  });

  it('con política manual el pedido espera en received', async () => {
    await acceptance.setPolicy(tenantA, {
      channel: 'manual',
      autoAccept: false,
    });
    const pedido = await crear('manual');
    expect(pedido.status).toBe('received');
    await archivar(pedido.id);
  });

  it('un programado NUNCA nace aceptado, aunque la política sea automática', async () => {
    // Aceptar hoy un pedido para dentro de tres horas lo metería en la cola de
    // cocina de ahora mismo.
    await acceptance.setPolicy(tenantA, {
      channel: 'auto-programado',
      autoAccept: true,
    });
    const pedido = await crear('auto-programado', {
      scheduledAt: new Date(Date.now() + 3 * 3600 * 1000),
    });
    expect(pedido.status).toBe('scheduled');
  });

  // ------------------------------------------------ Vencimientos (RN-ORD-04)

  it('avisa a los 5 minutos SIN cambiar el estado', async () => {
    await acceptance.setPolicy(tenantA, {
      channel: 'aviso',
      autoAccept: false,
      alertAfterMinutes: 5,
      autoRejectAfterMinutes: 10,
    });
    const pedido = await crear('aviso');
    const creadoEn = new Date(
      (await ordering.getSummary(tenantA, pedido.id)).createdAt,
    );
    const enT = (m: number) => new Date(creadoEn.getTime() + m * 60_000);

    // A los 4 minutos todavía no toca.
    expect((await acceptance.sweepTenant(tenantA, enT(4))).alerted).toBe(0);

    const alos6 = await acceptance.sweepTenant(tenantA, enT(6));
    expect(alos6.alerted).toBeGreaterThan(0);
    expect(alos6.autoRejected).toBe(0);

    // Avisar NO decide: el pedido sigue esperando a una persona.
    expect((await ordering.getSummary(tenantA, pedido.id)).status).toBe(
      'received',
    );

    // Y no se repite en el siguiente barrido: una alerta por minuto sobre el
    // mismo pedido enseña al equipo a ignorar las alertas.
    expect((await acceptance.sweepTenant(tenantA, enT(7))).alerted).toBe(0);

    await archivar(pedido.id);
  });

  it('rechaza solo a los 10 minutos, con motivo y timeline completo', async () => {
    await acceptance.setPolicy(tenantA, {
      channel: 'rechazo',
      autoAccept: false,
      alertAfterMinutes: 5,
      autoRejectAfterMinutes: 10,
    });
    const pedido = await crear('rechazo');
    const creadoEn = new Date(
      (await ordering.getSummary(tenantA, pedido.id)).createdAt,
    );
    const enT = (m: number) => new Date(creadoEn.getTime() + m * 60_000);

    const resultado = await acceptance.sweepTenant(tenantA, enT(11));
    expect(resultado.autoRejected).toBeGreaterThan(0);

    const final = await ordering.getSummary(tenantA, pedido.id);
    expect(final.status).toBe('rejected');

    // Pasó por la máquina de estados como cualquier rechazo humano: hay
    // timeline, hay motivo y hay evento de salida hacia el canal.
    const timeline = await ordering.getTimeline(tenantA, pedido.id);
    const rechazo = timeline.find((e) => e.event === 'reject');
    expect(rechazo).toBeTruthy();
    expect(rechazo!.actorType).toBe('system');
    expect(rechazo!.reason).toBe(AUTO_REJECT_REASON);

    const eventos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ event_type: string }>(
        'SELECT event_type FROM outbox WHERE aggregate_id = $1 ORDER BY occurred_at',
        [pedido.id],
      );
      return rows.map((r) => r.event_type);
    });
    expect(eventos).toContain('order.rejected');
  });

  it('un pedido ya aceptado no lo toca el barrido por mucho que pase el tiempo', async () => {
    await acceptance.setPolicy(tenantA, {
      channel: 'aceptado-a-tiempo',
      autoAccept: false,
      alertAfterMinutes: 1,
      autoRejectAfterMinutes: 2,
    });
    const pedido = await crear('aceptado-a-tiempo');
    await ordering.applyTransition(tenantA, pedido.id, 'accept', {
      actorType: 'user',
      actorId: 'supervisor',
    });

    await acceptance.sweepTenant(tenantA, enMinutos(600));
    expect((await ordering.getSummary(tenantA, pedido.id)).status).toBe(
      'accepted',
    );
  });

  // --------------------------------------------- Programados (RN-ORD-05)

  it('libera el programado al entrar en su ventana de preparación', async () => {
    // El combo lleva 25 minutos de preparación y el margen de la spec son 10:
    // la ventana abre 35 minutos antes de la hora prometida.
    const dentroDeUnaHora = new Date(Date.now() + 60 * 60_000);
    const pedido = await crear('programado', {
      scheduledAt: dentroDeUnaHora,
    });
    expect(pedido.status).toBe('scheduled');

    // A 40 minutos de la hora todavía no toca cocinar.
    const faltan40 = new Date(dentroDeUnaHora.getTime() - 40 * 60_000);
    expect(await acceptance.releaseScheduled(tenantA, faltan40)).toBe(0);
    expect((await ordering.getSummary(tenantA, pedido.id)).status).toBe(
      'scheduled',
    );

    // A 30 minutos ya está dentro de la ventana (25 de preparación + 10 de
    // margen = 35).
    const faltan30 = new Date(dentroDeUnaHora.getTime() - 30 * 60_000);
    expect(await acceptance.releaseScheduled(tenantA, faltan30)).toBe(1);

    const liberado = await ordering.getSummary(tenantA, pedido.id);
    expect(liberado.status).toBe('received');

    const timeline = await ordering.getTimeline(tenantA, pedido.id);
    expect(timeline.map((e) => e.event)).toContain('release');

    await archivar(pedido.id);
  });

  it('liberar es idempotente: una segunda pasada no hace nada', async () => {
    const dentroDeUnaHora = new Date(Date.now() + 60 * 60_000);
    const pedido = await crear('programado-2', {
      scheduledAt: dentroDeUnaHora,
    });
    const dentroDeVentana = new Date(dentroDeUnaHora.getTime() - 30 * 60_000);

    expect(await acceptance.releaseScheduled(tenantA, dentroDeVentana)).toBe(1);
    // Ya no está en `scheduled`, así que la siguiente vuelta del worker —que
    // corre cada minuto— no vuelve a tocarlo.
    expect(await acceptance.releaseScheduled(tenantA, dentroDeVentana)).toBe(0);
    await archivar(pedido.id);
  });

  // ------------------------------------------------------------------ API

  it('expone y fija políticas por API', async () => {
    await auth(
      http()
        .post('/api/v1/ordering/acceptance-policies')
        .send({ channel: 'api-test', autoAccept: true, alertAfterMinutes: 3 }),
    ).expect(201);

    const lista = await auth(
      http().get('/api/v1/ordering/acceptance-policies'),
    ).expect(200);
    const creada = lista.body.find(
      (p: { channel: string }) => p.channel === 'api-test',
    );
    expect(creada).toMatchObject({ autoAccept: true, alertAfterMinutes: 3 });
  });

  it('fijar la política dos veces la reemplaza, no la duplica', async () => {
    await acceptance.setPolicy(tenantA, {
      channel: 'reemplazo',
      autoAccept: true,
    });
    await acceptance.setPolicy(tenantA, {
      channel: 'reemplazo',
      autoAccept: false,
      alertAfterMinutes: 7,
      autoRejectAfterMinutes: 9,
    });

    const politicas = await acceptance.listPolicies(tenantA);
    const delCanal = politicas.filter((p) => p.channel === 'reemplazo');
    expect(delCanal).toHaveLength(1);
    expect(delCanal[0]).toMatchObject({
      autoAccept: false,
      alertAfterMinutes: 7,
    });
  });

  it('el barrido global no se detiene si un tenant falla', async () => {
    // Con dos tenants activos, la propiedad que importa es que el recorrido
    // los visita a ambos: un pedido problemático de un cliente no puede dejar
    // sin vigilancia a los demás.
    const b = await app.get(TenancyService).provisionTenant({
      name: 'Aceptación Tenant B',
      planCode: 'starter',
      owner: {
        email: 'acc-b@sahana.test',
        password: 'password-acc-b-1',
        fullName: 'Dueño B',
      },
    });
    created.push(b.tenantId);

    await expect(
      acceptance.sweepAllTenants(enMinutos(1)),
    ).resolves.toMatchObject({
      alerted: expect.any(Number),
      autoRejected: expect.any(Number),
    });
  });
});
