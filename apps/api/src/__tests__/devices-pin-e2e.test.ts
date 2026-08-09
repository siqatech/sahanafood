import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../app.module.js';
import { configureApp } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import * as schema from '../database/schema/index.js';
import { TenancyService } from '../modules/tenancy/index.js';
import {
  AuthService,
  DeviceService,
  MAX_PIN_ATTEMPTS,
  PinLockedError,
  InvalidPinError,
} from '../modules/identity/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Dispositivos POS y PIN de operador (RN-IDN-03, RN-IDN-04).
 * Incluye la prueba de FUERZA BRUTA de PIN que exige la spec 02.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Dispositivos POS y PIN', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 5 });
  const created: string[] = [];

  let tenantA = '';
  let tenantB = '';
  let ownerA = '';
  let tokenA = '';
  let cajeroA = '';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'POS Tenant A',
      planCode: 'growth',
      owner: {
        email: 'pos-a@sahana.test',
        password: 'password-pos-a-1',
        fullName: 'Dueño POS A',
      },
    });
    tenantA = a.tenantId;
    ownerA = a.ownerUserId;
    created.push(tenantA);

    const b = await tenancy.provisionTenant({
      name: 'POS Tenant B',
      planCode: 'growth',
      owner: {
        email: 'pos-b@sahana.test',
        password: 'password-pos-b-1',
        fullName: 'Dueño POS B',
      },
    });
    tenantB = b.tenantId;
    created.push(tenantB);

    // Un cajero en el tenant A para las pruebas de PIN.
    cajeroA = await withTenant(pool, tenantA, async (ctx) => {
      const hash = await AuthService.hashPassword('password-cajero-pos');
      const [u] = await ctx.db
        .insert(schema.users)
        .values({
          tenantId: tenantA,
          email: 'cajero-pos@sahana.test',
          passwordHash: hash,
          fullName: 'Cajero POS',
        })
        .returning({ id: schema.users.id });
      const [role] = await ctx.db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.code, 'cashier'))
        .limit(1);
      await ctx.db.insert(schema.userRoles).values({
        tenantId: tenantA,
        userId: u!.id,
        roleId: role!.id,
        scopeType: 'tenant',
        scopeId: null,
      });
      return u!.id;
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'pos-a@sahana.test', password: 'password-pos-a-1' })
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

  // ------------------------------------------------- Emparejamiento (RN-IDN-04)

  it('un administrador emite un código de emparejamiento', async () => {
    const res = await auth(
      http().post('/api/v1/devices/pairing-codes').send({}),
    ).expect(201);
    expect(res.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('el código empareja el dispositivo y solo sirve UNA vez', async () => {
    const issued = await auth(
      http().post('/api/v1/devices/pairing-codes').send({}),
    ).expect(201);

    const paired = await http()
      .post('/api/v1/devices/pair')
      .send({ code: issued.body.code, deviceName: 'Tablet Caja 1' })
      .expect(201);

    expect(paired.body.deviceId).toBeTruthy();
    expect(paired.body.deviceToken).toBeTruthy();
    expect(paired.body.tenantId).toBe(tenantA);

    // El SEGUNDO intento con el mismo código falla (un solo uso).
    await http()
      .post('/api/v1/devices/pair')
      .send({ code: issued.body.code, deviceName: 'Tablet Pirata' })
      .expect(403);
  });

  it('el emparejamiento NO requiere autenticación previa (la tablet no la tiene)', async () => {
    const issued = await auth(
      http().post('/api/v1/devices/pairing-codes').send({}),
    ).expect(201);
    // Sin cabecera Authorization.
    await http()
      .post('/api/v1/devices/pair')
      .send({ code: issued.body.code, deviceName: 'Tablet sin login' })
      .expect(201);
  });

  it('un código inventado es rechazado con el mismo mensaje que uno usado', async () => {
    const res = await http()
      .post('/api/v1/devices/pair')
      .send({ code: 'ZZZZ-ZZZZ', deviceName: 'Tablet falsa' })
      .expect(403);
    expect(res.body.detail).toContain('inválido o expirado');
  });

  it('un código caducado no empareja', async () => {
    const issued = await auth(
      http().post('/api/v1/devices/pairing-codes').send({}),
    ).expect(201);

    // Envejecer el código artificialmente.
    await withTenant(pool, tenantA, async (ctx) => {
      await ctx.client.query(
        `UPDATE idn_pairing_codes SET expires_at = now() - interval '1 minute'
          WHERE used_at IS NULL AND expires_at > now()`,
      );
    });

    await http()
      .post('/api/v1/devices/pair')
      .send({ code: issued.body.code, deviceName: 'Tablet tardía' })
      .expect(403);
  });

  it('el token de dispositivo autentica, y al revocarlo deja de servir', async () => {
    const devices = app.get(DeviceService);
    const issued = await auth(
      http().post('/api/v1/devices/pairing-codes').send({}),
    ).expect(201);
    const paired = await http()
      .post('/api/v1/devices/pair')
      .send({ code: issued.body.code, deviceName: 'Tablet Revocable' })
      .expect(201);

    // Autentica correctamente.
    const authed = await devices.authenticateDevice(paired.body.deviceToken);
    expect(authed.deviceId).toBe(paired.body.deviceId);
    expect(authed.tenantId).toBe(tenantA);

    // Revocar (tablet perdida) exige motivo, que queda en auditoría.
    await auth(
      http()
        .delete(`/api/v1/devices/${paired.body.deviceId}`)
        .send({ reason: 'Tablet extraviada en el local' }),
    ).expect(200);

    // El token deja de servir de inmediato.
    await expect(
      devices.authenticateDevice(paired.body.deviceToken),
    ).rejects.toThrow(/revocado|no autorizado/i);

    // Y la revocación quedó auditada con su motivo.
    const audit = await auth(http().get('/api/v1/audit?entity=device')).expect(
      200,
    );
    const evento = audit.body.items.find(
      (i: { action: string; resourceId: string }) =>
        i.action === 'device.revoked' && i.resourceId === paired.body.deviceId,
    );
    expect(evento).toBeTruthy();
    expect(evento.reason).toContain('extraviada');
  });

  it('revocar un dispositivo inexistente responde 404', async () => {
    await auth(
      http()
        .delete('/api/v1/devices/00000000-0000-0000-0000-000000000000')
        .send({ reason: 'Prueba' }),
    ).expect(404);
  });

  it('la revocación exige motivo', async () => {
    await auth(
      http()
        .delete('/api/v1/devices/00000000-0000-0000-0000-000000000000')
        .send({}),
    ).expect(422);
  });

  // ------------------------------------------------------- PIN (RN-IDN-03)

  it('acepta PIN de 4 a 6 dígitos y rechaza el resto', async () => {
    const devices = app.get(DeviceService);
    await expect(
      devices.setPin(tenantA, cajeroA, '4729'),
    ).resolves.toBeUndefined();
    await expect(
      devices.setPin(tenantA, cajeroA, '284617'),
    ).resolves.toBeUndefined();

    await expect(devices.setPin(tenantA, cajeroA, '123')).rejects.toThrow(
      /4 y 6 dígitos/,
    );
    await expect(devices.setPin(tenantA, cajeroA, '1234567')).rejects.toThrow(
      /4 y 6 dígitos/,
    );
    await expect(devices.setPin(tenantA, cajeroA, 'abcd')).rejects.toThrow(
      /4 y 6 dígitos/,
    );
  });

  it('rechaza PIN predecibles (repetidos o consecutivos)', async () => {
    const devices = app.get(DeviceService);
    await expect(devices.setPin(tenantA, cajeroA, '1111')).rejects.toThrow(
      /predecible/,
    );
    await expect(devices.setPin(tenantA, cajeroA, '1234')).rejects.toThrow(
      /predecible/,
    );
    await expect(devices.setPin(tenantA, cajeroA, '9876')).rejects.toThrow(
      /predecible/,
    );
  });

  it('verifica el PIN correcto', async () => {
    const devices = app.get(DeviceService);
    await devices.setPin(tenantA, cajeroA, '4729');
    const r = await devices.verifyPin(tenantA, cajeroA, '4729');
    expect(r.ok).toBe(true);
    expect(r.mustChange).toBe(false);
  });

  it('el PIN fijado por un administrador obliga a cambiarlo (RN-IDN-03)', async () => {
    const devices = app.get(DeviceService);
    await devices.setPin(tenantA, cajeroA, '5183', { mustChange: true });
    const r = await devices.verifyPin(tenantA, cajeroA, '5183');
    expect(r.mustChange).toBe(true);

    // Una acción sensible se rechaza hasta que lo cambie.
    await expect(
      devices.verifyPinForSensitiveAction(tenantA, cajeroA, '5183'),
    ).rejects.toThrow(/cambiar tu PIN/);

    // Tras cambiarlo, la acción sensible pasa.
    await devices.setPin(tenantA, cajeroA, '4729');
    await expect(
      devices.verifyPinForSensitiveAction(tenantA, cajeroA, '4729'),
    ).resolves.toBeUndefined();
  });

  it('un operador sin PIN configurado da 404', async () => {
    const devices = app.get(DeviceService);
    await expect(devices.verifyPin(tenantA, ownerA, '4729')).rejects.toThrow(
      /no tiene PIN/i,
    );
  });

  // ------------------------------- FUERZA BRUTA (prueba exigida por la spec)

  it('BLOQUEA el PIN tras 5 intentos fallidos y el bloqueo PERSISTE', async () => {
    const devices = app.get(DeviceService);
    await devices.setPin(tenantA, cajeroA, '4729');

    // Los primeros 4 fallos informan intentos restantes.
    for (let i = 1; i < MAX_PIN_ATTEMPTS; i++) {
      const error = await devices
        .verifyPin(tenantA, cajeroA, '0000')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidPinError);
      expect((error as InvalidPinError).extra['remainingAttempts']).toBe(
        MAX_PIN_ATTEMPTS - i,
      );
    }

    // El quinto bloquea.
    const bloqueo = await devices
      .verifyPin(tenantA, cajeroA, '0000')
      .catch((e: unknown) => e);
    expect(bloqueo).toBeInstanceOf(PinLockedError);

    // CLAVE: el contador sobrevivió a los errores lanzados. Si el incremento
    // ocurriera en la transacción que lanza, el rollback lo habría deshecho y
    // la fuerza bruta seguiría abierta.
    const estado = await withTenant(pool, tenantA, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.userPins)
        .where(
          and(
            eq(schema.userPins.tenantId, tenantA),
            eq(schema.userPins.userId, cajeroA),
          ),
        );
      return rows[0]!;
    });
    expect(estado.failedAttempts).toBe(MAX_PIN_ATTEMPTS);
    expect(estado.lockedUntil).toBeTruthy();
    expect(estado.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Estando bloqueado, ni siquiera el PIN CORRECTO abre.
    await expect(devices.verifyPin(tenantA, cajeroA, '4729')).rejects.toThrow(
      PinLockedError,
    );

    // El bloqueo quedó auditado.
    const audit = await auth(http().get('/api/v1/audit?entity=user')).expect(
      200,
    );
    expect(
      audit.body.items.some(
        (i: { action: string }) => i.action === 'pin.locked',
      ),
    ).toBe(true);
  });

  it('un acierto reinicia el contador de intentos', async () => {
    const devices = app.get(DeviceService);
    // setPin limpia el bloqueo anterior.
    await devices.setPin(tenantA, cajeroA, '4729');

    await devices.verifyPin(tenantA, cajeroA, '0000').catch(() => undefined);
    await devices.verifyPin(tenantA, cajeroA, '0000').catch(() => undefined);
    await devices.verifyPin(tenantA, cajeroA, '4729'); // acierto

    const estado = await withTenant(pool, tenantA, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.userPins)
        .where(
          and(
            eq(schema.userPins.tenantId, tenantA),
            eq(schema.userPins.userId, cajeroA),
          ),
        );
      return rows[0]!;
    });
    expect(estado.failedAttempts).toBe(0);
    expect(estado.lockedUntil).toBeNull();
  });

  it('cambiar el PIN levanta el bloqueo', async () => {
    const devices = app.get(DeviceService);
    await devices.setPin(tenantA, cajeroA, '4729');
    for (let i = 0; i <= MAX_PIN_ATTEMPTS; i++) {
      await devices.verifyPin(tenantA, cajeroA, '0000').catch(() => undefined);
    }
    await expect(devices.verifyPin(tenantA, cajeroA, '4729')).rejects.toThrow(
      PinLockedError,
    );

    // Un administrador restablece el PIN: se desbloquea.
    await devices.setPin(tenantA, cajeroA, '8351');
    const r = await devices.verifyPin(tenantA, cajeroA, '8351');
    expect(r.ok).toBe(true);
  });

  // ------------------------------------------------------- AISLAMIENTO

  it('un dispositivo del tenant A no aparece en el listado del tenant B', async () => {
    const devices = app.get(DeviceService);
    const listaA = await devices.listDevices(tenantA);
    const listaB = await devices.listDevices(tenantB);
    expect(listaA.length).toBeGreaterThan(0);
    const idsA = new Set(listaA.map((d) => (d as { id: string }).id));
    for (const d of listaB) {
      expect(idsA.has((d as { id: string }).id)).toBe(false);
    }
  });

  it('no se puede verificar el PIN de un usuario de otro tenant', async () => {
    const devices = app.get(DeviceService);
    // cajeroA pertenece al tenant A; se pregunta desde el contexto del tenant B.
    await expect(devices.verifyPin(tenantB, cajeroA, '8351')).rejects.toThrow(
      /no tiene PIN/i,
    );
  });

  it('el endpoint de emisión de códigos exige permiso de gestión', async () => {
    // El cajero tiene sesión pero no users.write.
    const login = await http()
      .post('/api/v1/auth/login')
      .send({
        email: 'cajero-pos@sahana.test',
        password: 'password-cajero-pos',
      })
      .expect(201);

    await http()
      .post('/api/v1/devices/pairing-codes')
      .set('authorization', `Bearer ${login.body.accessToken}`)
      .send({})
      .expect(403);
  });
  // ------------------------------------------- Sesión del POS (ux/01)

  /** Empareja una tablet nueva y devuelve su token. */
  async function emparejar(nombre: string): Promise<string> {
    const issued = await auth(
      http().post('/api/v1/devices/pairing-codes').send({}),
    ).expect(201);
    const paired = await http()
      .post('/api/v1/devices/pair')
      .send({ code: issued.body.code, deviceName: nombre })
      .expect(201);
    return paired.body.deviceToken as string;
  }

  it('EL POS ENTRA con dispositivo + PIN, y la sesión sirve para vender', async () => {
    // La prueba que decide si el POS puede existir. Antes de esto, una tablet
    // emparejada tenía un token y NINGUNA forma de usarlo: `authenticateDevice`
    // estaba escrito y no lo llamaba nadie desde HTTP.
    const deviceToken = await emparejar('Tablet Caja 1');
    await auth(
      http().post('/api/v1/auth/pin').send({ userId: cajeroA, pin: '2468' }),
    ).expect(201);

    // 1. La tablet pregunta quién puede entrar. Sin sesión de usuario.
    const lista = await http()
      .post('/api/v1/auth/pos/operators')
      .send({ deviceToken })
      .expect(201);
    expect(lista.body.device.deviceName).toBe('Tablet Caja 1');
    const cajero = lista.body.operators.find(
      (o: { userId: string }) => o.userId === cajeroA,
    );
    expect(cajero.fullName).toBe('Cajero POS');
    // Ni correos ni roles: esta lista se ve desde el otro lado del mostrador.
    expect(Object.keys(cajero).sort()).toEqual(['fullName', 'userId']);

    // 2. El cajero teclea su PIN y obtiene una sesión de usuario normal.
    const sesion = await http()
      .post('/api/v1/auth/pos/login')
      .send({ deviceToken, userId: cajeroA, pin: '2468' })
      .expect(201);
    expect(sesion.body.accessToken).toBeTruthy();
    expect(sesion.body.refreshToken).toBeTruthy();

    // 3. Y esa sesión SIRVE PARA VENDER. Un login que devuelve un token que
    //    luego no abre nada no habría sido detectado por los dos pasos de
    //    arriba.
    const perfil = await http()
      .get('/api/v1/auth/me')
      .set('authorization', `Bearer ${sesion.body.accessToken}`)
      .expect(200);
    expect(perfil.body.userId).toBe(cajeroA);
    expect(perfil.body.tenantId).toBe(tenantA);
    expect(perfil.body.permissions).toContain('orders.create');
  });

  it('el PIN correcto en una tablet REVOCADA no entra', async () => {
    // El dispositivo se comprueba PRIMERO, y esto es lo que lo demuestra: el
    // PIN es válido y aun así no se entra. Una tablet robada se revoca de un
    // clic y deja de servir aunque quien la tenga sepa el PIN.
    const issued = await auth(
      http().post('/api/v1/devices/pairing-codes').send({}),
    ).expect(201);
    const paired = await http()
      .post('/api/v1/devices/pair')
      .send({ code: issued.body.code, deviceName: 'Tablet Robada' })
      .expect(201);
    await auth(
      http().post('/api/v1/auth/pin').send({ userId: cajeroA, pin: '3571' }),
    ).expect(201);

    await auth(
      http()
        .delete(`/api/v1/devices/${paired.body.deviceId}`)
        .send({ reason: 'Tablet robada del mostrador' }),
    ).expect(200);

    await http()
      .post('/api/v1/auth/pos/login')
      .send({
        deviceToken: paired.body.deviceToken,
        userId: cajeroA,
        pin: '3571',
      })
      .expect(403);
  });

  it('sin dispositivo válido NO se prueban PINs: el contador no se toca', async () => {
    // Si el PIN se verificara antes que el dispositivo, cualquiera desde
    // internet podría bloquear la cuenta del cajero a base de intentos y dejar
    // al mostrador sin poder cobrar en hora punta.
    await auth(
      http().post('/api/v1/auth/pin').send({ userId: cajeroA, pin: '4826' }),
    ).expect(201);

    for (let i = 0; i < 6; i++) {
      await http()
        .post('/api/v1/auth/pos/login')
        .send({
          deviceToken: 'token-inventado-que-no-existe-en-ninguna-parte',
          userId: cajeroA,
          pin: '0000',
        })
        .expect(403);
    }

    // Seis intentos con un dispositivo falso y el PIN sigue vivo.
    const deviceToken = await emparejar('Tablet Sana');
    await http()
      .post('/api/v1/auth/pos/login')
      .send({ deviceToken, userId: cajeroA, pin: '4826' })
      .expect(201);
  });

  it('AISLAMIENTO: la tablet de A no lista ni deja entrar a nadie de B', async () => {
    const deviceToken = await emparejar('Tablet Aislada');
    const lista = await http()
      .post('/api/v1/auth/pos/operators')
      .send({ deviceToken })
      .expect(201);

    // El dueño de B no está en la lista de la tablet de A.
    const dueñoDeB = await withTenant(pool, tenantB, async (ctx) => {
      const rows = await ctx.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .limit(1);
      return rows[0]!.id;
    });
    expect(
      lista.body.operators.some(
        (o: { userId: string }) => o.userId === dueñoDeB,
      ),
    ).toBe(false);

    // Y aunque se conozca su id, la tablet de A no puede abrirle sesión.
    await withTenant(pool, tenantB, async (ctx) => {
      await ctx.client.query(
        `INSERT INTO idn_user_pins (tenant_id, user_id, pin_hash, must_change)
         VALUES ($1,$2,'no-importa',false)
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [tenantB, dueñoDeB],
      );
    });
    await http()
      .post('/api/v1/auth/pos/login')
      .send({ deviceToken, userId: dueñoDeB, pin: '1357' })
      .expect(404);
  });
});
