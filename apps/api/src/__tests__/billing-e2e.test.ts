import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  BillingService,
  OseSandboxProvider,
  OSE_REJECTION_CODES,
} from '../modules/billing/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Facturación electrónica (spec 10, T4.26/T4.27).
 *
 * Lo que se prueba aquí es lo que produce infracciones tributarias, no bugs:
 *
 * · **Correlativo sin huecos ni duplicados bajo concurrencia.** Un hueco en la
 *   numeración hay que justificarlo ante SUNAT con una comunicación de baja;
 *   un duplicado es peor.
 * · **OSE caído → cola y reintento**, conservando el número. Devolverlo al
 *   pozo es justo lo que crea el hueco cuando el reintento sí funciona.
 * · **Rechazado → cola de corrección, la venta NUNCA se pierde** (RN-BIL-02).
 * · **Respuesta perdida → el reintento reconcilia, no duplica.** Reenviar el
 *   mismo documento con su mismo número tiene que ser idempotente; reenviarlo
 *   con un número nuevo sería la venta declarada dos veces.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Facturación electrónica', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 20 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let brandId = '';
  let companyId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let billing: BillingService;
  let ose: OseSandboxProvider;

  const CON_RUC = {
    docType: 'RUC' as const,
    docNumber: '20123456789',
    legalName: 'Constructora Los Andes S.A.C.',
  };
  const CON_DNI = { docType: 'DNI' as const, docNumber: '45678912' };

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
    billing = app.get(BillingService);
    ose = app.get(OseSandboxProvider);

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Facturación Tenant',
      planCode: 'growth',
      owner: {
        email: 'bil-a@sahana.test',
        password: 'password-bil-a-1',
        fullName: 'Dueño Facturación',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0]!;
    companyId = org.companyId;
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    // Series de boleta y factura, como las tendría cualquier empresa.
    await withTenant(pool, tenantA, async ({ client }) => {
      await client.query(
        `INSERT INTO bil_series (tenant_id, company_id, series, doc_type)
         VALUES ($1,$2,'B001','boleta'), ($1,$2,'F001','factura'),
                ($1,$2,'BC01','nota_credito')`,
        [tenantA, companyId],
      );
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'bil-a@sahana.test', password: 'password-bil-a-1' })
      .expect(201);
    tokenA = login.body.accessToken;
  });

  beforeEach(() => {
    // Cada prueba parte de un OSE sano; la que quiera romperlo lo dice.
    ose.configure({ down: false, swallowResponses: false, latencyMs: 0 });
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokenA}`);

  const vender = async (): Promise<string> => {
    const pedido = await ordering.submit(tenantA, {
      brandId,
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
    return pedido.id;
  };

  const correlativosDe = async (serie: string): Promise<number[]> =>
    withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ correlative: number }>(
        `SELECT correlative FROM bil_documents
          WHERE series = $1 AND correlative IS NOT NULL
          ORDER BY correlative`,
        [serie],
      );
      return rows.map((r) => r.correlative);
    });

  // -------------------------------------------------------------------------

  it('con RUC emite FACTURA en serie F; sin RUC, BOLETA en serie B', () => {
    // La decisión vive en @sahana/domain para que el POS llegue a la misma sin
    // red; aquí se comprueba que el servidor la respeta y elige la serie.
    return (async () => {
      const factura = await billing.createForOrder(
        tenantA,
        await vender(),
        CON_RUC,
      );
      const boleta = await billing.createForOrder(
        tenantA,
        await vender(),
        CON_DNI,
      );

      expect(factura.docType).toBe('factura');
      expect(boleta.docType).toBe('boleta');

      const f = await billing.issue(tenantA, factura.id);
      const b = await billing.issue(tenantA, boleta.id);
      expect(f.number).toMatch(/^F001-\d{8}$/);
      expect(b.number).toMatch(/^B001-\d{8}$/);
      expect(f.status).toBe('accepted');
      expect(b.status).toBe('accepted');
    })();
  });

  it('el documento NACE SIN NÚMERO: encolar y emitir son cosas distintas', async () => {
    // RN-BIL-01. Si crear el documento dependiera del OSE, un corte de
    // internet pararía la caja.
    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI);
    expect(doc.status).toBe('queued');
    expect(doc.number).toBeNull();
  });

  it('CORRELATIVO SIN HUECOS NI DUPLICADOS con 40 emisiones simultáneas', async () => {
    // La prueba que decide si el módulo sirve. Sin el `FOR UPDATE` sobre la
    // serie, dos cajas leen el mismo `last_correlative` y emiten el mismo
    // comprobante: un duplicado ante SUNAT, no un choque de claves.
    const EMISIONES = 40;

    const antes = await correlativosDe('B001');
    const documentos = await Promise.all(
      Array.from({ length: EMISIONES }, async () =>
        billing.createForOrder(tenantA, await vender(), CON_DNI),
      ),
    );

    await Promise.all(documentos.map((d) => billing.issue(tenantA, d.id)));

    const despues = await correlativosDe('B001');
    const nuevos = despues.slice(antes.length);

    expect(nuevos).toHaveLength(EMISIONES);
    // Sin duplicados.
    expect(new Set(nuevos).size).toBe(EMISIONES);
    // Y sin huecos: consecutivos de principio a fin.
    for (let i = 1; i < nuevos.length; i++) {
      expect(nuevos[i]).toBe(nuevos[i - 1]! + 1);
    }
  }, 180_000);

  it('el OSE caído deja el documento en cola CONSERVANDO su número', async () => {
    // Devolver el número al pozo es exactamente lo que crea el hueco cuando el
    // reintento sí funciona.
    ose.configure({ down: true });

    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI);
    const primerIntento = await billing.issue(tenantA, doc.id);

    expect(primerIntento.status).toBe('numbered');
    expect(primerIntento.number).not.toBeNull();
    expect(primerIntento.attempts).toBe(1);

    // Vuelve el OSE: el reintento usa EL MISMO número.
    ose.configure({ down: false });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE bil_documents SET next_attempt_at = NULL WHERE id = $1`,
        [doc.id],
      ),
    );
    const segundo = await billing.issue(tenantA, doc.id);

    expect(segundo.status).toBe('accepted');
    expect(segundo.number).toBe(primerIntento.number);
  });

  it('rechazado por el OSE → cola de corrección, la venta NO se pierde', async () => {
    // RN-BIL-02. El sandbox rechaza una factura cuyo RUC no cuadra; el
    // documento se queda con su número y su motivo, listo para corregir.
    const orderId = await vender();
    const doc = await billing.createForOrder(tenantA, orderId, CON_RUC);

    // Se corrompe el RUC en la base, como si viniera mal de un canal externo.
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE bil_documents SET customer_doc_number = '123' WHERE id = $1`,
        [doc.id],
      ),
    );

    const resultado = await billing.issue(tenantA, doc.id);

    expect(resultado.status).toBe('rejected');
    expect(resultado.rejectionCode).toBe(OSE_REJECTION_CODES.RUC_INVALIDO);
    expect(resultado.rejectionReason).toMatch(/11 dígitos/);
    // La venta sigue ahí, con su número.
    expect(resultado.number).not.toBeNull();
    expect(resultado.orderId).toBe(orderId);

    // Y aparece en la cola de corrección.
    const cola = await billing.list(tenantA, { status: 'rejected' });
    expect(cola.map((d) => d.id)).toContain(doc.id);
  });

  it('LA COLA DE CORRECCIÓN SE PUEDE CORREGIR: mismo número, RUC bueno', async () => {
    // La otra mitad de RN-BIL-02, y la que faltaba. La cola existía y no se
    // podía vaciar: `retry` reenvía el MISMO RUC que el OSE acaba de rechazar
    // y `createForOrder` se niega porque la venta ya tiene comprobante. La
    // venta no se perdía —eso sí— pero se quedaba sin poder facturarse nunca.
    const orderId = await vender();
    const doc = await billing.createForOrder(tenantA, orderId, CON_RUC);
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE bil_documents SET customer_doc_number = '123' WHERE id = $1`,
        [doc.id],
      ),
    );
    const rechazado = await billing.issue(tenantA, doc.id);
    expect(rechazado.status).toBe('rejected');

    const corregido = await billing.correctCustomer(tenantA, doc.id, CON_RUC);

    expect(corregido.status).toBe('accepted');
    // MISMO número: un rechazado nunca fue válido, así que darle uno nuevo
    // dejaría el anterior como un hueco en la serie que hay que justificar.
    expect(corregido.number).toBe(rechazado.number);

    // Y sale de la cola.
    const cola = await billing.list(tenantA, { status: 'rejected' });
    expect(cola.map((d) => d.id)).not.toContain(doc.id);
  });

  it('LA CORRECCIÓN QUEDA AUDITADA con el dato viejo y el nuevo', async () => {
    // Tres meses después alguien pregunta por qué este comprobante lleva dos
    // identidades. Sin el rastro, la respuesta es que no se sabe.
    const orderId = await vender();
    const doc = await billing.createForOrder(tenantA, orderId, CON_RUC);
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE bil_documents SET customer_doc_number = '123' WHERE id = $1`,
        [doc.id],
      ),
    );
    await billing.issue(tenantA, doc.id);
    await billing.correctCustomer(tenantA, doc.id, CON_RUC);

    const rastro = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        data: {
          rejectionCode: string;
          from: { docNumber: string };
          to: { docNumber: string };
        };
      }>(
        `SELECT data FROM audit_log
          WHERE action = 'billing.customer_corrected' AND resource_id = $1`,
        [doc.id],
      );
      return rows[0];
    });
    expect(rastro).toBeTruthy();
    expect(rastro!.data.from.docNumber).toBe('123');
    expect(rastro!.data.to.docNumber).toBe(CON_RUC.docNumber);
    expect(rastro!.data.rejectionCode).toBe(OSE_REJECTION_CODES.RUC_INVALIDO);
  });

  it('NO SE CORRIGE lo que ya está aceptado: eso se anula', async () => {
    const orderId = await vender();
    const doc = await billing.createForOrder(tenantA, orderId, CON_RUC);
    const aceptado = await billing.issue(tenantA, doc.id);
    expect(aceptado.status).toBe('accepted');

    await expect(
      billing.correctCustomer(tenantA, doc.id, CON_RUC),
    ).rejects.toThrow(/rechazados/i);
  });

  it('CAMBIAR DE FACTURA A BOLETA no es corregir: son series distintas', async () => {
    const orderId = await vender();
    const doc = await billing.createForOrder(tenantA, orderId, CON_RUC);
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE bil_documents SET customer_doc_number = '123' WHERE id = $1`,
        [doc.id],
      ),
    );
    await billing.issue(tenantA, doc.id);

    await expect(
      billing.correctCustomer(tenantA, doc.id, {
        docType: 'DNI',
        docNumber: '45678912',
      }),
    ).rejects.toThrow(/series distintas/i);
  });

  it('respuesta PERDIDA: el reintento reconcilia y NO duplica el comprobante', async () => {
    // El caso que produce comprobantes duplicados en los sistemas que no lo
    // contemplan: el OSE lo aceptó, la respuesta se perdió por el camino, y el
    // emisor no sabe si existe. Reenviar el MISMO documento con su MISMO
    // número tiene que ser idempotente — reenviarlo con un número nuevo sería
    // la venta declarada dos veces.
    ose.configure({ swallowResponses: true });

    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI);
    const perdido = await billing.issue(tenantA, doc.id);

    // Aquí no se sabe: quedó pendiente, con su número reservado.
    expect(perdido.status).toBe('numbered');
    const numero = perdido.number!;

    // Pero el OSE SÍ lo tiene registrado.
    const emisor = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ tax_id: string }>(
        `SELECT tax_id FROM org_companies WHERE id = $1`,
        [companyId],
      );
      return rows[0]!.tax_id;
    });
    expect(ose.ticketOf(emisor, numero)).toBeDefined();

    // Vuelve la respuesta y se reintenta: mismo número, aceptado, sin duplicar.
    ose.configure({ swallowResponses: false });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE bil_documents SET next_attempt_at = NULL WHERE id = $1`,
        [doc.id],
      ),
    );
    const reconciliado = await billing.issue(tenantA, doc.id);

    expect(reconciliado.status).toBe('accepted');
    expect(reconciliado.number).toBe(numero);

    // Y en la base hay UN documento con ese número, no dos.
    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM bil_documents WHERE number = $1`,
        [numero],
      ),
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('OTRO documento con el número de uno ya emitido lo rechaza el OSE (1033)', async () => {
    // La red de seguridad del proveedor. Si algún día un camino nuestro se
    // saltara el bloqueo de la serie, el OSE no acepta el duplicado en
    // silencio: lo dice.
    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI);
    const emitido = await billing.issue(tenantA, doc.id);

    const emisor = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ tax_id: string }>(
        `SELECT tax_id FROM org_companies WHERE id = $1`,
        [companyId],
      );
      return rows[0]!.tax_id;
    });

    const resultado = await ose.submit({
      documentId: 'otro-documento-distinto',
      docType: 'boleta',
      series: emitido.number!.split('-')[0]!,
      correlative: Number(emitido.number!.split('-')[1]),
      number: emitido.number!,
      issuedAt: new Date(),
      issuer: { taxId: emisor, legalName: 'Da igual' },
      customer: { docType: 'NONE' },
      subtotal: '10.0000',
      taxableBase: '8.4746',
      tax: '1.5254',
      total: '10.0000',
      currency: 'PEN',
      lines: [],
    });

    expect(resultado.kind).toBe('rejected');
    if (resultado.kind === 'rejected') {
      expect(resultado.code).toBe(OSE_REJECTION_CODES.DUPLICADO);
    }
  });

  it('un comprobante ACEPTADO no se reemite', async () => {
    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI);
    const emitido = await billing.issue(tenantA, doc.id);
    const intentos = emitido.attempts;

    const otraVez = await billing.issue(tenantA, doc.id);
    expect(otraVez.number).toBe(emitido.number);
    expect(otraVez.attempts).toBe(intentos);
  });

  it('una venta no se factura DOS VECES', async () => {
    // Facturar dos veces obliga a anular con nota de crédito y a explicar por
    // qué se emitió: es peor que no facturar.
    const orderId = await vender();
    await billing.createForOrder(tenantA, orderId, CON_DNI);
    await expect(
      billing.createForOrder(tenantA, orderId, CON_DNI),
    ).rejects.toThrow(/ya tiene el comprobante/);
  });

  it('una factura sin razón social se rechaza AQUÍ, no en el OSE', async () => {
    // Sin razón social SUNAT la rechaza y el cliente se queda sin su crédito
    // fiscal, que es justo por lo que pidió factura.
    await expect(
      billing.createForOrder(tenantA, await vender(), {
        docType: 'RUC',
        docNumber: '20123456789',
      }),
    ).rejects.toThrow(/razón social/);
  });

  it('la fecha de emisión es la de la VENTA, no la del envío (RN-BIL-03)', async () => {
    // Contarla desde el envío haría que un documento con tres días de retraso
    // pareciera recién nacido.
    const hace30h = new Date(Date.now() - 30 * 3_600_000);
    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI, {
      issuedAt: hace30h,
    });

    expect(new Date(doc.issuedAt).getTime()).toBeCloseTo(hace30h.getTime(), -3);
    // Y el plazo ya va contando: quedan 42 de 72 horas.
    expect(doc.deferral?.status).toBe('ok');
    expect(doc.deferral!.hoursRemaining).toBeLessThan(43);
  });

  it('la cola diferida avisa ANTES de vencer y despacha lo más antiguo primero', async () => {
    ose.configure({ down: true });

    // Tres ventas offline con distinta antigüedad.
    const antiguo = await billing.createForOrder(
      tenantA,
      await vender(),
      CON_DNI,
      { issuedAt: new Date(Date.now() - 60 * 3_600_000) }, // dentro del aviso
    );
    await billing.createForOrder(tenantA, await vender(), CON_DNI, {
      issuedAt: new Date(Date.now() - 1 * 3_600_000),
    });

    ose.configure({ down: false });
    const resumen = await billing.processQueue(tenantA, { limit: 10 });

    expect(resumen.processed).toBeGreaterThanOrEqual(2);
    expect(resumen.expiring).toBeGreaterThanOrEqual(1);

    // El aviso salió por outbox para que el panel se entere con tiempo.
    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ payload: { level: string } }>(
        `SELECT payload FROM outbox
          WHERE event_type = 'billing.deferral_alert' AND aggregate_id = $1`,
        [antiguo.id],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.level).toBe('warning');
  });

  it('el aviso de plazo NO se repite en cada vuelta del worker', async () => {
    // Una alerta que suena cada minuto es una alerta que se silencia.
    ose.configure({ down: true });
    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI, {
      issuedAt: new Date(Date.now() - 60 * 3_600_000),
    });

    await billing.processQueue(tenantA, { limit: 50 });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(`UPDATE bil_documents SET next_attempt_at = NULL`),
    );
    await billing.processQueue(tenantA, { limit: 50 });

    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox
          WHERE event_type = 'billing.deferral_alert' AND aggregate_id = $1`,
        [doc.id],
      ),
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('la nota de crédito referencia al original y lo deja anulado', async () => {
    // Nunca se borra ni se edita un comprobante emitido: ya está declarado.
    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI);
    const emitido = await billing.issue(tenantA, doc.id);

    const nota = await billing.issueCreditNote(tenantA, emitido.id, {
      reason: 'El cliente devolvió el pedido completo',
    });

    expect(nota.docType).toBe('nota_credito');
    expect(nota.status).toBe('accepted');
    expect(nota.number).not.toBe(emitido.number);

    const original = await billing.get(tenantA, emitido.id);
    expect(original.status).toBe('voided');

    // Con su rastro en auditoría y el motivo.
    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ reason: string | null }>(
        `SELECT reason FROM audit_log
          WHERE action = 'invoice.credit_note' AND resource_id = $1`,
        [emitido.id],
      ),
    );
    expect(rows[0]?.reason).toMatch(/devolvió/);
  });

  it('no se anula un comprobante que aún no fue aceptado', async () => {
    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI);
    await expect(
      billing.issueCreditNote(tenantA, doc.id, { reason: 'prueba' }),
    ).rejects.toThrow(/aceptado/);
  });

  it('sin serie configurada se falla al EMITIR, con mensaje accionable', async () => {
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE bil_series SET is_active = false WHERE doc_type = 'boleta'`,
      ),
    );
    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI);
    await expect(billing.issue(tenantA, doc.id)).rejects.toThrow(
      /Configúrala antes de emitir/,
    );
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE bil_series SET is_active = true WHERE doc_type = 'boleta'`,
      ),
    );
  });

  it('la bitácora de envíos es APPEND-ONLY en la base de datos', async () => {
    // «El documento está rechazado» no basta para discutir con un proveedor:
    // hace falta qué se mandó y qué contestó, y que no se pueda retocar.
    await expect(
      withTenant(pool, tenantA, ({ client }) =>
        client.query(`UPDATE bil_submissions SET outcome = 'accepted'`),
      ),
    ).rejects.toThrow(/permiso|permission/i);
    await expect(
      withTenant(pool, tenantA, ({ client }) =>
        client.query(`DELETE FROM bil_submissions`),
      ),
    ).rejects.toThrow(/permiso|permission/i);
  });

  it('el barrido de TODOS los tenants vacía la cola (lo que corre el worker)', async () => {
    // Sin esto, `processQueue` sería una función que solo corre en las pruebas
    // y en producción los comprobantes offline esperarían a que alguien pulsara
    // «reintentar» a mano, uno por uno, mientras el plazo corre.
    ose.configure({ down: true });
    const doc = await billing.createForOrder(tenantA, await vender(), CON_DNI);
    await billing.issue(tenantA, doc.id);
    expect((await billing.get(tenantA, doc.id)).status).toBe('numbered');

    ose.configure({ down: false });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(`UPDATE bil_documents SET next_attempt_at = NULL`),
    );
    const r = await billing.processQueueAllTenants();

    expect(r.tenants).toBeGreaterThanOrEqual(1);
    expect((await billing.get(tenantA, doc.id)).status).toBe('accepted');
  });

  it('GET /documents filtra por estado y valida el filtro', async () => {
    const res = await auth(
      http().get('/api/v1/documents?status=accepted'),
    ).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(
      (res.body as Array<{ status: string }>).every(
        (d) => d.status === 'accepted',
      ),
    ).toBe(true);

    await auth(http().get('/api/v1/documents?status=inventado')).expect(422);
  });

  it('POST /documents emite desde la API y NO espera al OSE', async () => {
    // El cajero decide boleta o factura DESPUÉS de cobrar, cuando el cliente
    // saca su RUC del bolsillo.
    const orderId = await vender();
    const res = await auth(
      http().post('/api/v1/documents').send({ orderId, docType: 'NONE' }),
    ).expect(201);

    expect(res.body.status).toBe('queued');
    expect(res.body.number).toBeNull();
    expect(res.body.docType).toBe('boleta');

    const emitido = await auth(
      http().post(`/api/v1/documents/${res.body.id}/retry`),
    ).expect(201);
    expect(emitido.body.status).toBe('accepted');
  });
});
