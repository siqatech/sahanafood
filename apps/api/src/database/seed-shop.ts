import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PG_POOL } from './database.module.js';
import type { Pool } from 'pg';
import { withTenant } from './rls.js';
import { seedPlans } from './seed.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import { StorefrontService } from '../modules/storefront/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import { ConversationsService } from '../modules/conversations/index.js';
import { CashService } from '../modules/cash/index.js';
import { InventoryService } from '../modules/inventory/index.js';
import { BillingService } from '../modules/billing/index.js';
import { PaymentsService, CULQI_PROVIDER } from '../modules/payments/index.js';
import { DeliveryService } from '../modules/delivery/index.js';
import {
  AnalyticsEventHandlers,
  ANALYTICS_CONSUMER,
} from '../modules/analytics/index.js';
import { consumeEvent } from '../events/consumer.js';
import { relayOnce } from '../events/outbox.js';

/**
 * Siembra una tienda demo para levantar `apps/web` a mano (T5.08–T5.14).
 *
 * Existe porque la tienda no se puede mirar sin una: sin dominio verificado, el
 * host no resuelve y todas las páginas dan 404 — que es exactamente lo que debe
 * pasar, y por eso hace falta este atajo para desarrollo.
 *
 *   pnpm --filter @sahana/api seed:shop
 *
 * **Reinicia la API después de sembrar.** El sandbox del OSE recuerda EN
 * MEMORIA qué números de comprobante ya registró, y la semilla rehace el tenant
 * reusando el mismo RUC y la misma serie: para el sandbox, el F001-00000001
 * nuevo es otro documento con un número ya visto, y lo rechaza con 1033. Es el
 * comportamiento correcto —un OSE real haría lo mismo— y por eso se resuelve
 * reiniciando el proceso, no relajando la comprobación.
 *
 * El host por defecto es `demo.localhost`, que resuelve a 127.0.0.1 en los
 * navegadores modernos sin tocar `/etc/hosts`.
 */

const HOST = process.env['SHOP_HOST'] ?? 'demo.localhost';
const NOMBRE = 'Demo Tienda Web';

async function main(): Promise<void> {
  // `abortOnError: false`: con el valor por defecto, un fallo de arranque mata
  // el proceso sin imprimir nada y el script parece colgarse.
  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ['error', 'warn'],
  });

  const pool = app.get<Pool>(PG_POOL);
  await seedPlans(pool);

  // Se rehace desde cero en cada ejecución: un host es único globalmente, así
  // que dejar el anterior haría fallar la segunda pasada.
  await pool.query('DELETE FROM ten_tenants WHERE name = $1', [NOMBRE]);

  const tenant = await app.get(TenancyService).provisionTenant({
    name: NOMBRE,
    planCode: 'growth',
    owner: {
      email: 'demo-tienda@sahana.test',
      password: 'password-demo-tienda-1',
      fullName: 'Dueña de la tienda demo',
    },
  });

  const org = await withTenant(pool, tenant.tenantId, (ctx) =>
    seedDemoOrganization(ctx),
  );
  const brandId = org.brandIds[0]!;
  const catalogo = await withTenant(pool, tenant.tenantId, (ctx) =>
    seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
  );

  const storefront = app.get(StorefrontService);
  const dominio = await storefront.registerDomain(tenant.tenantId, {
    brandId,
    host: HOST,
  });
  await storefront.verifyDomain(tenant.tenantId, dominio.id);

  // Un cupón para poder probar el camino del descuento y el del mínimo.
  await withTenant(pool, tenant.tenantId, ({ client }) =>
    client.query(
      `INSERT INTO sto_coupons (tenant_id, brand_id, code, kind, percent_bps, min_order, is_welcome)
       VALUES ($1,$2,'BIENVENIDO','percent',1000,'50.0000',true)`,
      [tenant.tenantId, brandId],
    ),
  );

  // Dos pedidos APARTADOS en la bandeja de excepciones (RN-ORD-10). Sin ellos
  // la pantalla de excepciones solo se puede ver vacía, y una pantalla que solo
  // se puede mirar vacía no se puede desarrollar ni probar. Son dos porque el
  // flujo tiene dos salidas —resolver y rechazar— y cada una consume la suya.
  const ordering = app.get(OrderingService);
  for (const [ref, sku] of [
    ['DEMO-EXC-1', 'RAPPI-POLLO-XL'],
    ['DEMO-EXC-2', 'RAPPI-COMBO-2'],
  ] as const) {
    await ordering.submitForReview(tenant.tenantId, {
      brandId,
      locationId: org.locationId,
      channel: 'rappi',
      externalRef: ref,
      reason: `SKU externo sin mapear: ${sku}`,
      rawPayload: { order_id: ref, items: [{ sku, qty: 2 }] },
      customerName: 'Cliente de Rappi',
      customerPhone: '+51987000111',
    });
  }

  // Un pedido ESPERANDO ACEPTACIÓN, con su reloj corriendo. Sin él la torre de
  // control solo se puede mirar vacía, y una pantalla que solo se puede mirar
  // vacía no se puede desarrollar ni probar — que es exactamente cómo esta
  // pantalla acabó sin existir.
  await ordering.submit(tenant.tenantId, {
    brandId,
    locationId: org.locationId,
    channel: 'rappi',
    externalRef: 'DEMO-POR-ACEPTAR',
    lines: [{ productId: catalogo.comboId, quantity: 1 }],
    customerName: 'Cliente esperando',
  });

  // Una conversación DERIVADA por el bot y otra normal. La derivada es la que
  // justifica la bandeja: sin pantalla, el resumen que el agente escribe no lo
  // lee nadie y el cliente que pidió hablar con una persona se queda esperando.
  const conversaciones = app.get(ConversationsService);
  const derivada = await conversaciones.receiveInbound(tenant.tenantId, {
    brandId,
    channel: 'whatsapp',
    phone: '+51987123456',
    text: 'Quiero dos pollos para las 8, ¿me los pueden llevar?',
  });
  await conversaciones.handoffToHuman(
    tenant.tenantId,
    derivada.conversationId,
    {
      intent: 'Pedir 2 pollos a la brasa para las 20:00 con reparto',
      captured: { cantidad: 2, hora: '20:00', zona: 'Miraflores' },
      notes: 'Ya preguntó por el precio; se le dijo S/ 32.',
    },
  );
  await conversaciones.receiveInbound(tenant.tenantId, {
    brandId,
    channel: 'whatsapp',
    phone: '+51987654321',
    text: '¿A qué hora abren hoy?',
  });

  // Un turno de caja ABIERTO con movimientos de dos medios distintos. El de
  // tarjeta está a propósito: cuadra el turno pero no pone billetes en la
  // gaveta, y es justo la lectura que hace que un turno correcto parezca un
  // faltante enorme si la pantalla no separa las dos columnas.
  const caja = app.get(CashService);
  const turno = await caja.open(tenant.tenantId, {
    locationId: org.locationId,
    openedBy: tenant.ownerUserId,
    openingFloatMinor: 500_000, // S/ 50.00 de fondo
  });
  await caja.addMovement(tenant.tenantId, turno.id, {
    kind: 'sale',
    amountMinor: 320_000,
    method: 'cash',
  });
  await caja.addMovement(tenant.tenantId, turno.id, {
    kind: 'sale',
    amountMinor: 450_000,
    method: 'card',
  });
  await caja.addMovement(tenant.tenantId, turno.id, {
    kind: 'cash_out',
    amountMinor: 100_000,
    method: 'cash',
    reason: 'Compra de hielo',
  });

  // Dos insumos con stock y un par de movimientos en el kardex. Sin esto la
  // pantalla de inventario solo se puede mirar vacía, y una pantalla que solo
  // se puede mirar vacía no se puede desarrollar ni probar.
  const inventario = app.get(InventoryService);
  const insumos = await withTenant(
    pool,
    tenant.tenantId,
    async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO inv_items (tenant_id, name, unit, unit_cost, min_stock)
       VALUES ($1,'Pollo entero','g','0.0120','1000.0000'),
              ($1,'Papa','g','0.0030', NULL)
       RETURNING id`,
        [tenant.tenantId],
      );
      for (const fila of rows) {
        await client.query(
          `INSERT INTO inv_stock (tenant_id, warehouse_id, item_id, quantity)
         VALUES ($1,$2,$3,'0.0000')
         ON CONFLICT (tenant_id, warehouse_id, item_id) DO NOTHING`,
          [tenant.tenantId, org.warehouseId, fila.id],
        );
      }
      return rows.map((r) => r.id);
    },
  );

  // Una entrada y una merma: las dos caras que hacen legible un kardex. La
  // merca lleva motivo porque la base lo exige — un descuadre sin explicación
  // es peor que un descuadre.
  await inventario.recordAdjustment(tenant.tenantId, {
    warehouseId: org.warehouseId,
    itemId: insumos[0]!,
    quantity: '20000.0000',
    reason: 'Carga inicial del almacén',
    actorId: tenant.ownerUserId,
  });
  await inventario.recordAdjustment(tenant.tenantId, {
    warehouseId: org.warehouseId,
    itemId: insumos[0]!,
    quantity: '-1500.0000',
    reason: 'Merma: pollo que se pasó de tiempo en vitrina',
    actorId: tenant.ownerUserId,
  });

  // Series de comprobantes y TRES documentos: uno aceptado, uno en cola y uno
  // RECHAZADO por el OSE. El rechazado es el que justifica la pantalla: sin él
  // la cola de corrección solo se puede mirar vacía — que es exactamente cómo
  // acabó sin poder corregirse.
  await withTenant(pool, tenant.tenantId, ({ client }) =>
    client.query(
      `INSERT INTO bil_series (tenant_id, company_id, series, doc_type)
       VALUES ($1,$2,'B001','boleta'), ($1,$2,'F001','factura'),
              ($1,$2,'BC01','nota_credito')`,
      [tenant.tenantId, org.companyId],
    ),
  );

  const facturacion = app.get(BillingService);
  const ventaFacturada = await ordering.submit(tenant.tenantId, {
    brandId,
    locationId: org.locationId,
    channel: 'pos',
    lines: [{ productId: catalogo.comboId, quantity: 1 }],
    customerName: 'Constructora Los Andes S.A.C.',
  });
  const factura = await facturacion.createForOrder(
    tenant.tenantId,
    ventaFacturada.id,
    {
      docType: 'RUC',
      docNumber: '20123456789',
      legalName: 'Constructora Los Andes S.A.C.',
    },
  );
  // Se corrompe el RUC como si hubiera llegado mal desde el canal: es el caso
  // real de RN-BIL-02, y el único que produce un rechazo del OSE de verdad.
  await withTenant(pool, tenant.tenantId, ({ client }) =>
    client.query(
      `UPDATE bil_documents SET customer_doc_number = '123' WHERE id = $1`,
      [factura.id],
    ),
  );
  await facturacion.issue(tenant.tenantId, factura.id);

  const ventaBoleta = await ordering.submit(tenant.tenantId, {
    brandId,
    locationId: org.locationId,
    channel: 'pos',
    lines: [{ productId: catalogo.comboId, quantity: 1 }],
    customerName: 'Cliente del mostrador',
  });
  const boleta = await facturacion.createForOrder(
    tenant.tenantId,
    ventaBoleta.id,
    { docType: 'DNI', docNumber: '45678912' },
  );
  await facturacion.issue(tenant.tenantId, boleta.id);

  // Y uno EN COLA, sin enviar: es el que enseña el plazo de RN-BIL-03.
  const ventaEnCola = await ordering.submit(tenant.tenantId, {
    brandId,
    locationId: org.locationId,
    channel: 'pos',
    lines: [{ productId: catalogo.comboId, quantity: 1 }],
    customerName: 'Cliente sin declarar',
  });
  await facturacion.createForOrder(tenant.tenantId, ventaEnCola.id, {
    docType: 'NONE',
  });

  // Un cobro CAPTURADO sobre una venta. Sin él la sección de devoluciones del
  // pedido solo se puede mirar vacía — y una pantalla que solo se puede mirar
  // vacía es exactamente como el reembolso acabó sin tener pantalla.
  const pagos = app.get(PaymentsService);
  await pagos.createConnection(tenant.tenantId, {
    provider: CULQI_PROVIDER,
    webhookSecret: 'secreto-de-demo-para-la-firma',
  });
  const ventaPagada = await ordering.submit(tenant.tenantId, {
    brandId,
    locationId: org.locationId,
    channel: 'web',
    lines: [{ productId: catalogo.comboId, quantity: 1 }],
    customerName: 'Cliente que pagó online',
  });
  const intencion = await pagos.createIntent(tenant.tenantId, {
    orderId: ventaPagada.id,
    provider: CULQI_PROVIDER,
  });
  // Se marca capturado directamente en vez de simular el webhook: el camino del
  // webhook firmado tiene sus propias pruebas e2e y aquí lo único que hace
  // falta es el ESTADO FINAL sobre el que se pide una devolución.
  await withTenant(pool, tenant.tenantId, ({ client }) =>
    client.query(
      `UPDATE pay_intents
          SET status = 'captured', captured_at = now(), paid_amount = amount
        WHERE id = $1`,
      [intencion.id],
    ),
  );

  // Dos repartidores y un pedido esperando salir. Sin esto la mesa de despacho
  // solo se puede mirar vacía — y una pantalla que solo se puede mirar vacía es
  // exactamente como el reparto acabó sin tener ninguna.
  const reparto = app.get(DeliveryService);
  const motorizado = await reparto.createCourier(tenant.tenantId, {
    locationId: org.locationId,
    fullName: 'Luis Ramos',
    phone: '+51987222333',
    vehicle: 'moto',
    zoneIds: [org.zoneIds[0]],
    actorId: tenant.ownerUserId,
  });
  const ciclista = await reparto.createCourier(tenant.tenantId, {
    locationId: org.locationId,
    fullName: 'Ana Flores',
    phone: '+51987444555',
    vehicle: 'bici',
    actorId: tenant.ownerUserId,
  });
  // Un repartidor nace FUERA DE TURNO, y el ranking no propone a quien no está
  // en turno. Dejar a los dos así haría que la mesa de despacho dijera «nadie
  // disponible» nada más abrirla, que es verdad pero no sirve para verla.
  await reparto.setCourierStatus(tenant.tenantId, ciclista.id, 'available');
  // Un pedido LISTO y sin envío: es la primera columna de la mesa de despacho,
  // la que existe porque hoy el envío no nace solo al aceptar (PA-08).
  const ventaLista = await ordering.submit(tenant.tenantId, {
    brandId,
    locationId: org.locationId,
    channel: 'web',
    lines: [{ productId: catalogo.comboId, quantity: 1 }],
    customerName: 'Cliente esperando su reparto',
    customerPhone: '+51987888999',
  });
  for (const evento of [
    'accept',
    'start_preparing',
    'finish_preparing',
  ] as const) {
    await ordering.applyTransition(tenant.tenantId, ventaLista.id, evento, {
      actorId: tenant.ownerUserId,
    });
  }

  // Uno de los dos ya está en la calle: la columna «en la calle» vacía no
  // distingue «no hay nadie repartiendo» de «esto no funciona».
  const ventaEnReparto = await ordering.submit(tenant.tenantId, {
    brandId,
    locationId: org.locationId,
    channel: 'web',
    lines: [{ productId: catalogo.comboId, quantity: 1 }],
    customerName: 'Cliente que espera en casa',
    customerPhone: '+51987666777',
  });
  const envio = await reparto.createShipment(tenant.tenantId, {
    orderId: ventaEnReparto.id,
    // Contra entrega: es el importe que después tiene que cuadrar con la caja
    // al liquidar el turno (RN-DLV-02).
    codAmountMinor: 320_000,
    actorId: tenant.ownerUserId,
  });
  await reparto.assign(
    tenant.tenantId,
    envio.id,
    motorizado.id,
    tenant.ownerUserId,
  );

  // Dos ventas ENTREGADAS por canales distintos: sin ellas la pantalla de
  // rentabilidad solo se puede mirar vacía, y es la pregunta que justifica el
  // producto entero —qué marca gana dinero por qué canal—.
  for (const canal of ['rappi', 'web'] as const) {
    const venta = await ordering.submit(tenant.tenantId, {
      brandId,
      locationId: org.locationId,
      channel: canal,
      lines: [{ productId: catalogo.comboId, quantity: 2 }],
      customerName: `Cliente de ${canal}`,
    });
    for (const evento of [
      'accept',
      'start_preparing',
      'finish_preparing',
      'pack',
      'dispatch',
      'deliver',
    ] as const) {
      await ordering.applyTransition(tenant.tenantId, venta.id, evento, {
        actorId: tenant.ownerUserId,
      });
    }
  }

  // La analítica se alimenta por EVENTOS, no consultando pedidos: aquí se drena
  // el outbox por el mismo camino que en producción recorre el worker. Sembrar
  // la tabla de rollup a mano habría enseñado números que el sistema real no
  // produce.
  const manejadores = app.get(AnalyticsEventHandlers).handlers();
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const entregados: Array<Record<string, unknown>> = [];
    await relayOnce(
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
      200,
    );
    if (entregados.length === 0) break;
    for (const mensaje of entregados) {
      await consumeEvent(
        {
          pool,
          consumer: ANALYTICS_CONSUMER,
          handlers: manejadores as never,
        },
        mensaje as never,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        tenantId: tenant.tenantId,
        brandId,
        host: HOST,
        tienda: `http://${HOST}:3001/`,
        cupon: 'BIENVENIDO (10 %, mínimo S/ 50)',
        excepciones: `http://${HOST}:3001/panel/excepciones`,
        operaciones: `http://${HOST}:3001/panel/operaciones`,
        conversaciones: `http://${HOST}:3001/panel/conversaciones`,
        caja: `http://${HOST}:3001/panel/caja`,
        inventario: `http://${HOST}:3001/panel/inventario`,
        comprobantes: `http://${HOST}:3001/panel/comprobantes`,
        reparto: `http://${HOST}:3001/panel/reparto`,
        rentabilidad: `http://${HOST}:3001/panel/reportes`,
        pedidoConCobro: `http://${HOST}:3001/panel/pedidos/${ventaPagada.id}`,
      },
      null,
      2,
    ),
  );

  await app.close();
}

await main();
