import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { recordAudit } from '../modules/audit/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Leer la auditoría (spec 17, docs/14#auditoria).
 *
 * `audit_log` es append-only por construcción —el rol de aplicación no tiene
 * `UPDATE` ni `DELETE` (migración 0002)— y eso solo sirve de algo si alguien
 * puede leerlo. Se escribía desde F3 en cuarenta sitios y la única ruta que lo
 * devolvía entregaba las filas crudas: `actorId` es un UUID, y «3f2a8c… cambió
 * un precio» no contesta la pregunta que lleva a alguien a mirar la auditoría,
 * que siempre es QUIÉN.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Auditoría: leerla, no solo escribirla', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 6 });
  const created: string[] = [];
  let tenantId = '';
  let token = '';
  let cajeroId = '';

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
    const t = await app.get(TenancyService).provisionTenant({
      name: 'Auditoría Tenant',
      planCode: 'growth',
      owner: {
        email: 'auditoria@sahana.test',
        password: 'password-auditoria-1',
        fullName: 'Dueña Auditoría',
      },
    });
    tenantId = t.tenantId;
    created.push(tenantId);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'auditoria@sahana.test',
        password: 'password-auditoria-1',
      })
      .expect(201);
    token = login.body.accessToken;

    // Por HTTP y no llamando al servicio: el actor sale del token, y es
    // justamente ese dato —quién lo hizo— el que esta suite comprueba.
    const creado = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('authorization', `Bearer ${token}`)
      .send({
        email: 'cajero-auditoria@sahana.test',
        fullName: 'Cajero Auditado',
        password: 'password-cajero-aud',
        roleCode: 'cashier',
      })
      .expect(201);
    cajeroId = creado.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const auth = (r: request.Test) => r.set('authorization', `Bearer ${token}`);

  it('DICE QUIÉN, no un UUID', async () => {
    // El nombre no se guarda en la fila a propósito —una persona se renombra y
    // el histórico no se reescribe— así que se resuelve al leer.
    const res = await auth(
      request(app.getHttpServer()).get(
        `/api/v1/audit?action=identity.user_created`,
      ),
    ).expect(200);

    const suya = res.body.items.find(
      (i: { resourceId: string }) => i.resourceId === cajeroId,
    );
    expect(suya, 'el alta del cajero no quedó auditada').toBeTruthy();
    expect(suya.actorName).toBe('Dueña Auditoría');
    expect(suya.data.role).toBe('cashier');
  });

  it('FILTRA POR ACCIÓN, que es como se busca de verdad', async () => {
    // «¿Quién cambió precios este mes?» no se contesta con un filtro por
    // entidad: `product` mezcla precios, pausas y altas.
    const res = await auth(
      request(app.getHttpServer()).get('/api/v1/audit?action=auth.login'),
    ).expect(200);

    expect(res.body.items.length).toBeGreaterThan(0);
    expect(
      res.body.items.every(
        (i: { action: string }) => i.action === 'auth.login',
      ),
    ).toBe(true);
  });

  it('OFRECE LAS ACCIONES QUE HAY, no una lista escrita a mano', async () => {
    // Una lista fija se desvía al añadir una acción, y ofrecer filtros que no
    // devuelven nada hace dudar de si el filtro falla o el hecho no ocurrió.
    const res = await auth(
      request(app.getHttpServer()).get('/api/v1/audit/actions'),
    ).expect(200);

    const nombres = res.body.map((a: { action: string }) => a.action);
    expect(nombres).toContain('tenant.created');
    expect(nombres).toContain('identity.user_created');
    const login = res.body.find(
      (a: { action: string }) => a.action === 'auth.login',
    );
    expect(login.count).toBeGreaterThan(0);
  });

  it('NO PIERDE la línea de alguien que ya no existe', async () => {
    // Quien firmó puede haberse dado de baja. Perder su línea del histórico
    // por eso sería justo lo contrario de auditar.
    const fantasma = '00000000-0000-4000-8000-000000000999';
    await withTenant(pool, tenantId, (ctx) =>
      recordAudit(ctx, {
        actorType: 'user',
        actorId: fantasma,
        action: 'inventory.adjusted',
        resourceType: 'item',
        resourceId: fantasma,
        data: { quantity: '-1000.0000' },
      }),
    );

    const res = await auth(
      request(app.getHttpServer()).get(
        '/api/v1/audit?action=inventory.adjusted',
      ),
    ).expect(200);

    const suya = res.body.items.find(
      (i: { actorId: string }) => i.actorId === fantasma,
    );
    expect(suya, 'la línea de un usuario borrado desapareció').toBeTruthy();
    expect(suya.actorName).toBeNull();
  });

  it('EL ACTOR NO-USUARIO no revienta la consulta', async () => {
    // `actor_id` es texto porque también guarda actores que no son usuarios.
    // Un `::uuid` sin guardia convertiría toda la consulta en un error 500 en
    // cuanto una sola fila tuviera algo que no fuera un UUID.
    await withTenant(pool, tenantId, (ctx) =>
      recordAudit(ctx, {
        actorType: 'system',
        actorId: 'worker-de-aceptacion',
        action: 'order.cancelled',
        resourceType: 'order',
        data: {},
      }),
    );

    const res = await auth(
      request(app.getHttpServer()).get('/api/v1/audit?limit=200'),
    ).expect(200);
    const suya = res.body.items.find(
      (i: { actorId: string }) => i.actorId === 'worker-de-aceptacion',
    );
    expect(suya).toBeTruthy();
    expect(suya.actorName).toBeNull();
  });

  it('EL HISTÓRICO NO SE PUEDE TOCAR: no hay ruta que lo intente', async () => {
    // La inmutabilidad la garantiza la base (migración 0002), pero una ruta de
    // escritura sería una invitación a concederle el permiso «temporalmente».
    await auth(
      request(app.getHttpServer()).post('/api/v1/audit').send({}),
    ).expect(404);
  });
});
