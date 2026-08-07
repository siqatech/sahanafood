import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { AppModule } from '../app.module.js';
import { CONFIG, type AppConfig } from '../config/config.js';
import { PG_POOL } from '../database/database.module.js';
import { AcceptanceService } from '../modules/ordering/index.js';
import {
  relayOnce,
  pendingCount,
  oldestPendingAgeSeconds,
} from '../events/outbox.js';
import {
  createQueuePublisher,
  createRedis,
  DOMAIN_EVENTS_QUEUE,
} from '../events/queue.js';
import { consumeEvent } from '../events/consumer.js';
import {
  KitchenEventHandlers,
  KITCHEN_CONSUMER,
  type DomainEventMessage,
} from '../modules/kitchen/index.js';
import {
  InventoryEventHandlers,
  INVENTORY_CONSUMER,
} from '../modules/inventory/index.js';
import { BillingService } from '../modules/billing/index.js';
import { Worker } from 'bullmq';
import {
  outboxPending,
  outboxOldestPendingSeconds,
} from '../observability/metrics.js';
import { startTracing, stopTracing } from '../observability/tracing.js';
import { PeriodicJob } from './periodic-job.js';

/**
 * Proceso WORKER: lo que hace que las reglas de fondo ocurran de verdad.
 *
 * Hasta ahora el relay del outbox y el barrido de aceptación existían y estaban
 * probados, pero nadie los llamaba fuera de las pruebas. En un despliegue eso
 * significa que los eventos no salen del outbox (la cocina no ve los pedidos) y
 * que ningún pedido vence solo. Este proceso cierra esa distancia.
 *
 * Va SEPARADO de la API a propósito:
 *  · Se escala distinto. La API escala con el tráfico de clientes; el worker,
 *    con el volumen de eventos. Meterlos en el mismo proceso obliga a escalar
 *    ambos por el peor de los dos.
 *  · Un pico de trabajo de fondo no puede robar CPU a las peticiones que un
 *    cliente está esperando.
 *  · Se puede desplegar y reiniciar sin cortar la atención al público.
 *
 * Varias instancias son seguras: el relay reclama con FOR UPDATE SKIP LOCKED y
 * el barrido de aceptación es idempotente (la alerta se marca con un UPDATE
 * condicional y el rechazo pasa por la máquina de estados, que descarta el
 * segundo intento).
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');

  // Igual que en la API: las instrumentaciones parchean al cargar, así que el
  // tracing arranca antes de construir nada.
  const configPrevia = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  startTracing({ serviceName: 'sahana-worker', endpoint: configPrevia });

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  const config = app.get<AppConfig>(CONFIG);
  const pool = app.get<Pool>(PG_POOL);
  const acceptance = app.get(AcceptanceService);
  const billing = app.get(BillingService);

  const redis = createRedis(config.redisUrl);
  const publisher = createQueuePublisher(redis);

  // Consumidores de eventos de dominio. Es lo que hace que cocina y el
  // inventario se enteren de los pedidos: sin ellos, `order.accepted` sería un
  // evento que nadie escucha.
  // Conexión propia porque BullMQ bloquea la suya esperando trabajo, y
  // compartirla con el publicador dejaría al relay esperando su turno.
  const consumerRedis = createRedis(config.redisUrl);

  /**
   * Cada módulo es un CONSUMIDOR con su propio nombre en `inbox`, y todos ven
   * el mismo mensaje.
   *
   * Un único mapa evento→handler no serviría: cocina e inventario escuchan
   * los dos `order.accepted`, y el segundo pisaría al primero sin que nada
   * avisara. Tampoco sirve levantar dos Workers de BullMQ sobre la misma cola:
   * se repartirían los trabajos en vez de duplicarlos, y la mitad de los
   * pedidos no llegaría a cocina.
   *
   * Al ir cada uno en su propia transacción con su propia marca de `inbox`, un
   * fallo del inventario no deshace el ticket de cocina: el reintento vuelve a
   * pasar por los dos y el que ya estaba hecho responde `skipped`.
   */
  const consumidores = [
    {
      nombre: KITCHEN_CONSUMER,
      handlers: app.get(KitchenEventHandlers).handlers(),
    },
    {
      nombre: INVENTORY_CONSUMER,
      handlers: app.get(InventoryEventHandlers).handlers(),
    },
  ];

  const consumer = new Worker<DomainEventMessage>(
    DOMAIN_EVENTS_QUEUE,
    async (job) => {
      for (const { nombre, handlers } of consumidores) {
        const resultado = await consumeEvent(
          { pool, consumer: nombre, handlers },
          job.data,
        );
        if (resultado === 'processed') {
          logger.debug(
            `Evento aplicado por "${nombre}": ${job.data.eventType}`,
          );
        }
      }
    },
    { connection: consumerRedis, concurrency: 4 },
  );

  consumer.on('failed', (job, error) => {
    // BullMQ reintenta con backoff (5 intentos). Se registra cada fallo porque
    // un evento que agota los intentos es un pedido sin ticket.
    logger.error(
      `Evento ${job?.data?.eventType ?? 'desconocido'} falló (intento ${job?.attemptsMade ?? 0}): ${error.message}`,
    );
  });

  const relay = new PeriodicJob({
    name: 'outbox-relay',
    intervalMs: config.worker.outboxIntervalMs,
    run: async () => {
      const publicados = await relayOnce(
        pool,
        publisher.publish,
        config.worker.outboxBatchSize,
      );
      // Las métricas de salud se refrescan en cada vuelta, publicara o no: un
      // outbox creciendo con el relay vivo y un relay muerto se distinguen
      // justo por estas dos series (ADR-0007, alerta > 1 000 pendientes).
      outboxPending.set(await pendingCount(pool));
      outboxOldestPendingSeconds.set(await oldestPendingAgeSeconds(pool));
      if (publicados > 0) {
        logger.debug(`Relay: ${publicados} eventos publicados.`);
      }
    },
  });

  const aceptacion = new PeriodicJob({
    name: 'acceptance-sweep',
    intervalMs: config.worker.acceptanceIntervalMs,
    // Se desfasa del relay para no arrancar los dos en el mismo instante y
    // pelearse por las conexiones del pool en el peor momento (el arranque).
    initialDelayMs: 5_000,
    run: async () => {
      const r = await acceptance.sweepAllTenants();
      if (r.alerted > 0 || r.autoRejected > 0) {
        logger.log(
          `Barrido de aceptación: ${r.alerted} avisados, ${r.autoRejected} rechazados automáticamente.`,
        );
      }
    },
  });

  /**
   * Cola de facturación diferida (RN-BIL-03).
   *
   * Una venta sin internet deja su comprobante en cola, y SUNAT da un plazo
   * desde la fecha de emisión. Sin esta vuelta, ese comprobante se queda ahí
   * hasta que alguien pulse «reintentar» a mano — y el plazo corre igual.
   *
   * Cada 30 s: es un compromiso entre no machacar al OSE y no perder tiempo de
   * un plazo que se cuenta en horas.
   */
  const facturacion = new PeriodicJob({
    name: 'billing-queue',
    intervalMs: config.worker.billingIntervalMs,
    // Desfasado de los otros dos para no arrancar los tres a la vez y pelearse
    // por las conexiones del pool justo en el arranque.
    initialDelayMs: 10_000,
    run: async () => {
      const r = await billing.processQueueAllTenants();
      if (r.processed > 0 || r.expiring > 0) {
        logger.log(
          `Cola de facturación: ${r.accepted}/${r.processed} aceptados, ${r.expiring} cerca del plazo.`,
        );
      }
    },
  });

  relay.start();
  aceptacion.start();
  facturacion.start();
  logger.log(
    `Worker activo — relay cada ${config.worker.outboxIntervalMs} ms, ` +
      `aceptación cada ${config.worker.acceptanceIntervalMs} ms, ` +
      `facturación cada ${config.worker.billingIntervalMs} ms, ` +
      `consumidores [${consumidores.map((c) => c.nombre).join(', ')}] escuchando eventos de dominio.`,
  );

  let cerrando = false;
  const apagar = async (senal: string): Promise<void> => {
    if (cerrando) return;
    cerrando = true;
    logger.log(`${senal} recibido: terminando la vuelta en curso...`);
    // El orden importa: primero se dejan de programar vueltas y se espera a la
    // que esté viva, y solo entonces se cierran cola, Redis y pool. Cerrarlos
    // antes abortaría una transacción a medias en cada despliegue.
    await Promise.all([relay.stop(), aceptacion.stop(), facturacion.stop()]);
    // `close()` del consumidor espera a que termine el job en curso: matarlo a
    // mitad dejaría una transacción abortada y el evento por reintentar.
    await consumer.close();
    await publisher.close();
    redis.disconnect();
    consumerRedis.disconnect();
    await app.close();
    await stopTracing();
    logger.log('Worker detenido limpiamente.');
    process.exit(0);
  };

  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));
}

void bootstrap();
