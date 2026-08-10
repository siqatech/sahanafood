import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Alta del EQUIPO (spec 02, `specs/ux/03` → Configuración/usuarios).
 *
 * Faltaba entero: los nueve roles se creaban en cada tenant, el guardia los
 * comprobaba en cada petición, el POS entraba con usuario + PIN… y **no había
 * forma de crear un segundo usuario**. El único era el propietario que nace con
 * el tenant, así que en un local el dueño acababa dándole SU contraseña al
 * cajero — la cuenta que aprueba descuadres y firma en auditoría.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Equipo — alta, rol y baja', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 6 });
  const created: string[] = [];
  let token = '';
  let ownerId = '';

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
      name: 'Equipo Tenant',
      planCode: 'growth',
      owner: {
        email: 'equipo-owner@sahana.test',
        password: 'password-equipo-1',
        fullName: 'Dueña del local',
      },
    });
    created.push(t.tenantId);
    ownerId = t.ownerUserId;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: 'equipo-owner@sahana.test',
        password: 'password-equipo-1',
      })
      .expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('authorization', `Bearer ${token}`);

  it('LOS ROLES QUE SE OFRECEN salen del servidor, no de la pantalla', async () => {
    // Una lista duplicada en el panel se desvía el día que se añada un rol:
    // ofrecería uno inexistente o escondería uno real.
    const roles = await auth(http().get('/api/v1/users/roles')).expect(200);
    const codigos = roles.body.map((r: { code: string }) => r.code);
    expect(codigos).toContain('cashier');
    expect(codigos).toContain('cook');
    // `owner` NO se ofrece: fabricar otro propietario convertiría una cuenta
    // de administrador comprometida en una toma de control permanente.
    expect(codigos).not.toContain('owner');
  });

  it('SE DA DE ALTA UN CAJERO y puede entrar con lo suyo', async () => {
    const creado = await auth(
      http().post('/api/v1/users').send({
        email: 'cajero@sahana.test',
        fullName: 'Cajero del turno',
        password: 'password-cajero-1',
        roleCode: 'cashier',
      }),
    ).expect(201);

    expect(creado.body.roles).toHaveLength(1);
    expect(creado.body.roles[0].code).toBe('cashier');
    expect(creado.body.isOwner).toBe(false);

    // Y entra CON SU CUENTA, que es el punto entero: sin esto el dueño le
    // presta la suya y la auditoría deja de significar nada.
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'cajero@sahana.test', password: 'password-cajero-1' })
      .expect(201);
    expect(login.body.accessToken).toBeTruthy();

    // Con los permisos de SU rol, no con los del dueño: un cajero no da de
    // alta a nadie.
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('authorization', `Bearer ${login.body.accessToken}`)
      .send({
        email: 'otro@sahana.test',
        fullName: 'Otro',
        password: 'password-otro-12',
        roleCode: 'cook',
      })
      .expect(403);
  });

  it('el correo repetido se rechaza con un motivo, no con un 500', async () => {
    const r = await auth(
      http().post('/api/v1/users').send({
        email: 'cajero@sahana.test',
        fullName: 'Otro cajero',
        password: 'password-cajero-2',
        roleCode: 'cashier',
      }),
    ).expect(422);
    expect(r.body.detail).toMatch(/ya hay alguien/i);
  });

  it('NADIE puede fabricar otro propietario', async () => {
    await auth(
      http().post('/api/v1/users').send({
        email: 'falso-dueno@sahana.test',
        fullName: 'Dueño falso',
        password: 'password-falso-12',
        roleCode: 'owner',
      }),
    ).expect(403);
  });

  it('CAMBIAR DE ROL reemplaza, no acumula', async () => {
    // Acumular deja cajeros que siguen aprobando descuadres porque un día
    // cubrieron un turno de supervisor.
    const lista = await auth(http().get('/api/v1/users')).expect(200);
    const cajero = lista.body.find(
      (u: { email: string }) => u.email === 'cajero@sahana.test',
    );

    const cambiado = await auth(
      http().post(`/api/v1/users/${cajero.id}/role`).send({
        roleCode: 'supervisor',
      }),
    ).expect(201);

    expect(cambiado.body.roles).toHaveLength(1);
    expect(cambiado.body.roles[0].code).toBe('supervisor');
  });

  it('AL PROPIETARIO no se le cambia el rol ni se le desactiva', async () => {
    // Es la única cuenta sin escalón por encima: dejarla fuera deja el negocio
    // sin nadie que pueda recuperarlo.
    await auth(
      http().post(`/api/v1/users/${ownerId}/role`).send({ roleCode: 'cook' }),
    ).expect(403);

    await auth(
      http().post(`/api/v1/users/${ownerId}/status`).send({ active: false }),
    ).expect(403);
  });

  it('DESACTIVAR no borra: el histórico lleva su nombre dentro', async () => {
    const lista = await auth(http().get('/api/v1/users')).expect(200);
    const cajero = lista.body.find(
      (u: { email: string }) => u.email === 'cajero@sahana.test',
    );

    const baja = await auth(
      http().post(`/api/v1/users/${cajero.id}/status`).send({ active: false }),
    ).expect(201);
    expect(baja.body.status).toBe('disabled');

    // Sigue en la lista: su nombre está en cada pedido que tomó y en cada
    // arqueo que cerró.
    const despues = await auth(http().get('/api/v1/users')).expect(200);
    expect(despues.body.some((u: { id: string }) => u.id === cajero.id)).toBe(
      true,
    );
  });
});
