import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { VersioningType, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { AppModule } from '../app.module.js';
import { ProblemDetailsFilter } from '../common/problem-details.filter.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import * as schema from '../database/schema/index.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Pruebas e2e de identidad y aislamiento (specs 01, 02, 17).
 *
 * Incluye la PRUEBA DE AISLAMIENTO POR ENDPOINT obligatoria (docs/09 §6):
 * fixture de 2 tenants y verificación de que cada uno solo ve lo suyo.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Identity + Tenancy e2e', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 5 });
  const created: string[] = [];

  // Fixture de dos tenants con un propietario cada uno.
  const A = {
    email: 'owner-a@sahana.test',
    password: 'password-a-123',
    tenantId: '',
  };
  const B = {
    email: 'owner-b@sahana.test',
    password: 'password-b-123',
    tenantId: '',
  };
  let tokenA = '';
  let tokenB = '';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'Tenant A',
      planCode: 'growth',
      owner: { email: A.email, password: A.password, fullName: 'Dueño A' },
    });
    A.tenantId = a.tenantId;
    created.push(a.tenantId);

    const b = await tenancy.provisionTenant({
      name: 'Tenant B',
      planCode: 'growth',
      owner: { email: B.email, password: B.password, fullName: 'Dueño B' },
    });
    B.tenantId = b.tenantId;
    created.push(b.tenantId);
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());

  // ----------------------------------------------------------------- Login

  it('login devuelve access y refresh', async () => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email: A.email, password: A.password })
      .expect(201);

    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    tokenA = res.body.accessToken;

    const resB = await http()
      .post('/api/v1/auth/login')
      .send({ email: B.email, password: B.password })
      .expect(201);
    tokenB = resB.body.accessToken;
  });

  it('rechaza contraseña incorrecta sin revelar si el email existe', async () => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email: A.email, password: 'contraseña-equivocada' })
      .expect(403);
    expect(res.body.detail).toBe('Credenciales inválidas.');

    const res2 = await http()
      .post('/api/v1/auth/login')
      .send({
        email: 'no-existe@sahana.test',
        password: 'contraseña-equivocada',
      })
      .expect(403);
    // Mismo mensaje: no filtra existencia de la cuenta.
    expect(res2.body.detail).toBe(res.body.detail);
  });

  it('valida la entrada con Problem Details', async () => {
    const res = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'no-es-email', password: 'x' })
      .expect(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.type).toContain('validation');
  });

  // ------------------------------------------------- Aislamiento por endpoint

  it('GET /tenant devuelve SOLO el tenant del token (2 tenants)', async () => {
    const a = await http()
      .get('/api/v1/tenant')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    const b = await http()
      .get('/api/v1/tenant')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);

    expect(a.body.id).toBe(A.tenantId);
    expect(b.body.id).toBe(B.tenantId);
    expect(a.body.id).not.toBe(b.body.id);
    expect(a.body.name).toBe('Tenant A');
    expect(b.body.name).toBe('Tenant B');
  });

  it('GET /audit no muestra registros de otro tenant', async () => {
    const a = await http()
      .get('/api/v1/audit')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    const b = await http()
      .get('/api/v1/audit')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);

    // Cada tenant tiene su propia alta + su login; nunca los del otro.
    expect(a.body.items.length).toBeGreaterThan(0);
    expect(
      a.body.items.every(
        (i: { resourceId: string }) => i.resourceId !== B.tenantId,
      ),
    ).toBe(true);
    expect(
      b.body.items.every(
        (i: { resourceId: string }) => i.resourceId !== A.tenantId,
      ),
    ).toBe(true);
  });

  it('sin token, los endpoints protegidos responden 403', async () => {
    await http().get('/api/v1/tenant').expect(403);
    await http().get('/api/v1/audit').expect(403);
  });

  it('un token manipulado es rechazado', async () => {
    await http()
      .get('/api/v1/tenant')
      .set('authorization', `Bearer ${tokenA}.manipulado`)
      .expect(403);
  });

  // -------------------------------------------------------------- Permisos

  it('el permiso audit.read se exige (cajero no puede leer auditoría)', async () => {
    // Crear un cajero en el tenant A y autenticarlo.
    const tenancy = app.get(TenancyService);
    void tenancy;
    const cashierEmail = 'cajero-a@sahana.test';
    await withTenant(pool, A.tenantId, async (ctx) => {
      const { AuthService } = await import('../modules/identity/index.js');
      const hash = await AuthService.hashPassword('password-cajero-1');
      const [user] = await ctx.db
        .insert(schema.users)
        .values({
          tenantId: A.tenantId,
          email: cashierEmail,
          passwordHash: hash,
          fullName: 'Cajero A',
        })
        .returning({ id: schema.users.id });
      const [role] = await ctx.db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.code, 'cashier'))
        .limit(1);
      await ctx.db.insert(schema.userRoles).values({
        tenantId: A.tenantId,
        userId: user!.id,
        roleId: role!.id,
        scopeType: 'tenant',
        scopeId: null,
      });
    });

    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: cashierEmail, password: 'password-cajero-1' })
      .expect(201);

    // El cajero NO tiene audit.read ni tenant.read.
    await http()
      .get('/api/v1/audit')
      .set('authorization', `Bearer ${login.body.accessToken}`)
      .expect(403);
  });

  // ---------------------------------------------- Refresh rotativo (RN-IDN-02)

  it('el refresh rota y el token viejo deja de servir', async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: B.email, password: B.password })
      .expect(201);
    const first = login.body.refreshToken;

    const rotated = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(201);
    expect(rotated.body.refreshToken).not.toBe(first);

    // El nuevo funciona...
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(201);
  });

  it('REUSO de un refresh rotado revoca la familia completa (RN-IDN-02)', async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: A.email, password: A.password })
      .expect(201);
    const first = login.body.refreshToken;

    const second = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(201);

    // Reusar el PRIMERO (ya rotado) = señal de robo.
    const reuse = await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(403);
    expect(reuse.body.detail).toContain('reutilización');

    // Y el segundo, aunque era válido, queda revocado con toda la familia.
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second.body.refreshToken })
      .expect(403);

    // El intento quedó auditado.
    const audit = await http()
      .get('/api/v1/audit?entity=session_family')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(
      audit.body.items.some(
        (i: { action: string }) => i.action === 'auth.refresh_reuse_detected',
      ),
    ).toBe(true);
  });

  it('logout revoca la familia', async () => {
    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: B.email, password: B.password })
      .expect(201);
    await http()
      .post('/api/v1/auth/logout')
      .send({ refreshToken: login.body.refreshToken })
      .expect(201);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(403);
  });

  // --------------------------------------------------- Auditoría inalterable

  it('audit_log no admite UPDATE ni DELETE desde el rol de app', async () => {
    await expect(
      withTenant(pool, A.tenantId, async (ctx) => {
        await ctx.client.query("UPDATE audit_log SET action = 'manipulado'");
      }),
    ).rejects.toThrow(/permission denied|denegado/i);

    await expect(
      withTenant(pool, A.tenantId, async (ctx) => {
        await ctx.client.query('DELETE FROM audit_log');
      }),
    ).rejects.toThrow(/permission denied|denegado/i);
  });

  // ------------------------------------------------ Suspensión (RN-TEN-03)

  it('un tenant suspendido no puede iniciar sesión y sus datos siguen ahí', async () => {
    const tenancy = app.get(TenancyService);
    const temp = await tenancy.provisionTenant({
      name: 'Tenant Suspendido',
      planCode: 'starter',
      owner: {
        email: 'owner-susp@sahana.test',
        password: 'password-susp-123',
        fullName: 'Dueño S',
      },
    });
    created.push(temp.tenantId);

    await http()
      .post('/api/v1/auth/login')
      .send({ email: 'owner-susp@sahana.test', password: 'password-susp-123' })
      .expect(201);

    await tenancy.suspend(temp.tenantId, 'Prueba de suspensión');

    const blocked = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'owner-susp@sahana.test', password: 'password-susp-123' })
      .expect(403);
    expect(blocked.body.detail).toContain('suspendido');

    // Los datos NO se borran.
    const users = await withTenant(pool, temp.tenantId, async (ctx) =>
      ctx.db.select().from(schema.users),
    );
    expect(users.length).toBe(1);
  });

  // ------------------------------------------------------ Límites (RN-TEN-02)

  it('el límite de usuarios del plan se hace cumplir con 429', async () => {
    const tenancy = app.get(TenancyService);
    // Plan starter: 5 usuarios. Ya existe el propietario.
    const t = await tenancy.provisionTenant({
      name: 'Tenant Límite',
      planCode: 'starter',
      owner: {
        email: 'owner-limite@sahana.test',
        password: 'password-limite-1',
        fullName: 'Dueño L',
      },
    });
    created.push(t.tenantId);

    const limits = await tenancy.getLimits(t.tenantId);
    expect(limits.limits.users).toBe(5);
    expect(limits.usage.users).toBe(1);

    // Rellenar hasta el límite: 4 usuarios más (total 5).
    const { AuthService } = await import('../modules/identity/index.js');
    const hash = await AuthService.hashPassword('password-relleno-1');
    for (let i = 0; i < 4; i++) {
      await withTenant(pool, t.tenantId, async (ctx) => {
        await tenancy.assertWithinLimit(ctx, 'users');
        await ctx.db.insert(schema.users).values({
          tenantId: t.tenantId,
          email: `relleno-${i}@sahana.test`,
          passwordHash: hash,
          fullName: `Relleno ${i}`,
        });
      });
    }

    // El sexto debe ser rechazado con LIMIT_EXCEEDED (429).
    await expect(
      withTenant(pool, t.tenantId, async (ctx) => {
        await tenancy.assertWithinLimit(ctx, 'users');
      }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
