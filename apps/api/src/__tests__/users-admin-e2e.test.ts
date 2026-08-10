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

  it('EL PIN es lo que le deja entrar al POS', async () => {
    // Una cuenta sin PIN es una forma silenciosa de no estar dado de alta:
    // la persona existe, puede entrar al panel, y no puede abrir caja.
    const lista = await auth(http().get('/api/v1/users')).expect(200);
    const cajero = lista.body.find(
      (u: { email: string }) => u.email === 'cajero@sahana.test',
    );
    expect(cajero.hasPin).toBe(false);

    await auth(
      http().post('/api/v1/auth/pin').send({ userId: cajero.id, pin: '4821' }),
    ).expect(201);

    const despues = await auth(http().get('/api/v1/users')).expect(200);
    expect(
      despues.body.find((u: { id: string }) => u.id === cajero.id).hasPin,
    ).toBe(true);
  });

  it('EL CÓDIGO DE EMPAREJAMIENTO caduca y empareja una sola vez', async () => {
    // Sin esto no hay forma de poner en marcha una tablet: el código ES la
    // credencial con la que un aparato sin cuenta entra al sistema.
    const emitido = await auth(
      http().post('/api/v1/devices/pairing-codes').send({}),
    ).expect(201);
    expect(emitido.body.code).toBeTruthy();
    expect(new Date(emitido.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const emparejado = await http()
      .post('/api/v1/devices/pair')
      .send({ code: emitido.body.code, deviceName: 'Tablet del mostrador' })
      .expect(201);
    expect(emparejado.body.deviceToken).toBeTruthy();

    // De UN SOLO USO: el segundo canje falla. Si no, el código anotado en el
    // mostrador sigue sirviendo para emparejar tablets ajenas.
    //
    // Falla con 403, no con 422: lo que se rechaza es una CREDENCIAL gastada,
    // no un cuerpo mal formado. Y el mensaje no distingue «ya usado» de «no
    // existe» — decirlo confirmaría a quien prueba códigos cuáles fueron
    // válidos alguna vez.
    const gastado = await http()
      .post('/api/v1/devices/pair')
      .send({ code: emitido.body.code, deviceName: 'Tablet intrusa' })
      .expect(403);
    expect(gastado.body.detail).toMatch(/inválido o expirado/i);

    const dispositivos = await auth(http().get('/api/v1/devices')).expect(200);
    expect(
      dispositivos.body.some(
        (d: { name: string }) => d.name === 'Tablet del mostrador',
      ),
    ).toBe(true);
    expect(
      dispositivos.body.some(
        (d: { name: string }) => d.name === 'Tablet intrusa',
      ),
    ).toBe(false);
  });

  it('REVOCAR una tablet exige motivo y la deja fuera', async () => {
    const dispositivos = await auth(http().get('/api/v1/devices')).expect(200);
    const tablet = dispositivos.body.find(
      (d: { name: string }) => d.name === 'Tablet del mostrador',
    );

    // Sin motivo no se revoca: una tablet revocada sin explicación deja sin
    // respuesta la pregunta de si se perdió o simplemente se devolvió.
    await auth(
      http().delete(`/api/v1/devices/${tablet.id}`).send({ reason: '' }),
    ).expect(422);

    await auth(
      http()
        .delete(`/api/v1/devices/${tablet.id}`)
        .send({ reason: 'Se perdió en el reparto' }),
    ).expect(200);

    const despues = await auth(http().get('/api/v1/devices')).expect(200);
    expect(
      despues.body.find((d: { id: string }) => d.id === tablet.id).status,
    ).not.toBe('active');
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
