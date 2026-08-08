import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withSystem, withTenant } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import { DomainError } from '../../../common/errors.js';
import { ModifierError, PricingError } from '@sahana/domain';
import { currentTraceId, withSpan } from '../../../observability/tracing.js';
import { OrderingService, type SubmitLineInput } from '../../ordering/index.js';
import {
  ConnectorParseError,
  type ChannelConnector,
  type WebhookHeaders,
} from '../domain/channel-connector.js';
import {
  ConnectionService,
  type ResolvedConnection,
} from './connection.service.js';
import { SimulatorConnector } from './connectors/simulator.connector.js';
import {
  webhooksReceived,
  webhooksRejected,
  webhooksProcessed,
} from '../../../observability/metrics.js';

/**
 * Ingesta de pedidos externos (spec 13 + spec 05 §11.1).
 *
 * TODA la arquitectura de este servicio existe para sostener una sola frase:
 * **un webhook al que respondimos 202 termina siempre en un pedido, aunque sea
 * en la bandeja de excepciones.** Nunca en un log de errores, nunca en nada.
 *
 * De ahí salen las dos mitades:
 *
 * - `receiveWebhook` (camino síncrono, RN-INT-01 < 250 ms): verifica la firma y
 *   ESCRIBE EL PAYLOAD CRUDO. No mapea catálogo, no calcula precios, no toca
 *   `ord_*`. Cuanto menos haga, menos hay que pueda fallar entre el ack y el
 *   disco. Un ack rápido también evita que el proveedor reintente por timeout,
 *   que es el origen habitual de los duplicados.
 *
 * - `processPending` (camino asíncrono): reclama con FOR UPDATE SKIP LOCKED
 *   DENTRO de una transacción. Si el proceso muere a mitad, el ROLLBACK suelta
 *   el cerrojo y la fila vuelve a estar pendiente — sin lease, sin temporizador
 *   y sin barrido de zombis, que son las tres piezas donde suelen perderse los
 *   mensajes. La creación del pedido va en su propia transacción de tenant y su
 *   idempotencia la garantiza el índice único de `ord_orders`, así que
 *   reprocesar es inofensivo.
 *
 * NOTA DE OPERACIÓN: `processPending` mantiene una conexión de sistema abierta
 * mientras abre otra de tenant. El pool debe tener al menos
 * `concurrencia × 2 + 1` conexiones, o los workers se bloquearán entre sí
 * esperando una conexión que ninguno soltará.
 */

export interface AckResult {
  eventId: string;
  /** true si este envío exacto ya se había recibido antes. */
  duplicateDelivery: boolean;
}

export class WebhookSignatureError extends DomainError {
  readonly status = 401;
  readonly type = 'https://errors.sahana.food/webhook-signature-invalid';
  readonly title = 'Firma de webhook inválida';
}

export class WebhookConnectionError extends DomainError {
  readonly status = 404;
  readonly type = 'https://errors.sahana.food/webhook-connection-unknown';
  readonly title = 'Conexión de integración desconocida';
}

export class WebhookConnectionPausedError extends DomainError {
  readonly status = 503;
  readonly type = 'https://errors.sahana.food/webhook-connection-paused';
  readonly title = 'Conexión de integración pausada';
}

/** Intentos antes de mandar un envío a la cola de muertos. */
export const MAX_INGESTION_ATTEMPTS = 5;

interface PendingRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  provider: string;
  delivery_id: string;
  external_ref: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  trace_id: string | null;
}

export interface ProcessResult {
  processed: number;
  toOrder: number;
  toReview: number;
  failed: number;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly connectors = new Map<string, ChannelConnector>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly connections: ConnectionService,
    private readonly ordering: OrderingService,
  ) {
    this.register(new SimulatorConnector());
  }

  /** Los conectores reales de F7 se registran aquí sin tocar la ingesta. */
  register(connector: ChannelConnector): void {
    this.connectors.set(connector.provider, connector);
  }

  connectorFor(provider: string): ChannelConnector {
    const c = this.connectors.get(provider);
    if (!c) {
      throw new WebhookConnectionError(
        `No hay conector registrado para el proveedor "${provider}".`,
      );
    }
    return c;
  }

  /**
   * Camino síncrono del webhook (RN-INT-01).
   *
   * `rawBody` es el cuerpo SIN parsear a propósito: cualquier viaje por
   * `JSON.parse` + `stringify` reordena claves y cambia espacios, y el HMAC se
   * calcula sobre bytes. Verificar la firma sobre un cuerpo re-serializado
   * fallaría con payloads perfectamente legítimos.
   */
  async receiveWebhook(
    webhookToken: string,
    rawBody: string,
    headers: WebhookHeaders,
  ): Promise<AckResult> {
    const conexion = await this.connections.resolveByWebhookToken(webhookToken);
    if (!conexion) {
      // Mismo mensaje que para una firma mala sería preferible, pero el
      // proveedor necesita distinguir «URL equivocada» de «secreto rotado».
      throw new WebhookConnectionError('Conexión de integración desconocida.');
    }
    if (conexion.status === 'disabled') {
      throw new WebhookConnectionError('Conexión de integración desconocida.');
    }
    if (conexion.status === 'paused') {
      // 503 y no 4xx: pausar es temporal, y queremos que el canal reintente.
      throw new WebhookConnectionPausedError(
        'La conexión está pausada; reintenta más tarde.',
      );
    }

    const connector = this.connectorFor(conexion.provider);
    webhooksReceived.inc({ provider: conexion.provider });

    if (!connector.verifyWebhook(rawBody, headers, conexion.signingSecret)) {
      // Firma inválida: NO se encola nada. Aceptar y apartar payloads no
      // firmados convertiría la bandeja de excepciones en un buzón abierto a
      // cualquiera que conozca la URL.
      webhooksRejected.inc({
        provider: conexion.provider,
        reason: 'bad_signature',
      });
      throw new WebhookSignatureError(
        'La firma del webhook no coincide con el secreto de la conexión.',
      );
    }

    // A partir de aquí el envío está autenticado y NO puede perderse. Un
    // payload que ni siquiera es JSON se guarda igual, en crudo, para que la
    // fase de proceso lo aparte a la bandeja con su contenido original.
    let payload: unknown;
    let payloadJson: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
      payloadJson =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)
          : { __valor: payload };
    } catch {
      payload = undefined;
      payloadJson = { __cuerpo_no_json: rawBody };
    }

    const identidad = connector.identify(payload, headers);

    return withTenant(this.pool, conexion.tenantId, async (ctx) => {
      const insertado = await ctx.db
        .insert(schema.integrationWebhookEvents)
        .values({
          tenantId: conexion.tenantId,
          connectionId: conexion.id,
          provider: conexion.provider,
          deliveryId: identidad.deliveryId,
          externalRef: identidad.externalRef ?? null,
          eventType: identidad.eventType,
          payload: payloadJson,
          headers: this.safeHeaders(headers),
          traceId: currentTraceId() ?? null,
        })
        // El MISMO envío dos veces no se procesa dos veces. Un REENVÍO del
        // mismo pedido (delivery_id distinto) sí entra: lo deduplica después
        // `ord_orders`, que es donde importa.
        .onConflictDoNothing()
        .returning({ id: schema.integrationWebhookEvents.id });

      if (insertado[0]) {
        return { eventId: insertado[0].id, duplicateDelivery: false };
      }

      const previo = await ctx.client.query<{ id: string }>(
        'SELECT id FROM int_webhook_events WHERE tenant_id = $1 AND provider = $2 AND delivery_id = $3',
        [conexion.tenantId, conexion.provider, identidad.deliveryId],
      );
      return { eventId: previo.rows[0]!.id, duplicateDelivery: true };
    });
  }

  /**
   * Procesa hasta `limit` envíos pendientes. Devuelve el desglose para que el
   * llamador (worker o prueba) pueda comprobar la invariante de cero pérdida.
   */
  async processPending(limit = 20): Promise<ProcessResult> {
    const resultado: ProcessResult = {
      processed: 0,
      toOrder: 0,
      toReview: 0,
      failed: 0,
    };

    for (let i = 0; i < limit; i++) {
      const uno = await this.processOne();
      if (uno === 'empty') break;
      resultado.processed++;
      if (uno === 'order') resultado.toOrder++;
      else if (uno === 'review') resultado.toReview++;
      else resultado.failed++;
    }
    return resultado;
  }

  /**
   * Reclama y procesa UN envío. Separado a propósito: es la unidad que la
   * prueba de caos interrumpe a mitad.
   */
  async processOne(): Promise<'empty' | 'order' | 'review' | 'failed'> {
    return withSystem(this.pool, async ({ client }) => {
      const { rows } = await client.query<PendingRow>(
        `SELECT id, tenant_id, connection_id, provider, delivery_id, external_ref,
                event_type, payload, attempts, trace_id
           FROM int_webhook_events
          WHERE status = 'pending'
          ORDER BY received_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      const evento = rows[0];
      if (!evento) return 'empty';

      try {
        const { orderId, aparted } = await withSpan(
          `integrations.process ${evento.provider}`,
          {
            'sahana.webhook.id': evento.id,
            'sahana.webhook.delivery_id': evento.delivery_id,
            'sahana.origin.trace_id': evento.trace_id ?? 'sin-traza',
          },
          () => this.resolveToOrder(evento),
        );

        await client.query(
          `UPDATE int_webhook_events
              SET status = 'done', order_id = $2, processed_at = now(),
                  attempts = attempts + 1, last_error = NULL
            WHERE id = $1`,
          [evento.id, orderId],
        );
        webhooksProcessed.inc({
          provider: evento.provider,
          outcome: aparted ? 'needs_review' : 'order',
        });
        return aparted ? 'review' : 'order';
      } catch (error) {
        // Fallo NO atribuible al payload (BD caída, conector sin registrar).
        // El envío sigue vivo: se cuenta el intento y se reintenta. Solo tras
        // agotar los intentos pasa a la cola de muertos, que es una alarma
        // operativa, no un descarte silencioso.
        const intentos = evento.attempts + 1;
        const agotado = intentos >= MAX_INGESTION_ATTEMPTS;
        const mensaje = error instanceof Error ? error.message : String(error);

        await client.query(
          `UPDATE int_webhook_events
              SET status = $2, attempts = $3, last_error = $4
            WHERE id = $1`,
          [evento.id, agotado ? 'failed' : 'pending', intentos, mensaje],
        );
        this.logger.error(
          `Fallo procesando webhook ${evento.id} (intento ${intentos}/${MAX_INGESTION_ATTEMPTS}): ${mensaje}`,
        );
        if (agotado) {
          webhooksProcessed.inc({
            provider: evento.provider,
            outcome: 'failed',
          });
        }
        return 'failed';
      }
    });
  }

  /**
   * Convierte un envío en pedido. Cualquier problema ATRIBUIBLE AL CONTENIDO
   * —payload roto, SKU sin mapear, fuera de cobertura— termina en la bandeja de
   * excepciones, nunca en una excepción propagada: propagarla dejaría el envío
   * reintentándose para siempre contra un payload que jamás va a mejorar solo.
   */
  private async resolveToOrder(
    evento: PendingRow,
  ): Promise<{ orderId: string; aparted: boolean }> {
    const connector = this.connectorFor(evento.provider);
    const conexion = await this.loadConnection(
      evento.tenant_id,
      evento.connection_id,
    );

    // Sin referencia externa se usa el id de entrega: el pedido debe tener una
    // clave de dedupe sí o sí, o un reintento crearía un segundo pedido.
    const externalRef = evento.external_ref ?? evento.delivery_id;
    const traceId = evento.trace_id ?? undefined;

    const aBandeja = async (
      motivo: string,
    ): Promise<{ orderId: string; aparted: boolean }> => {
      const pedido = await this.ordering.submitForReview(evento.tenant_id, {
        brandId: conexion.brandId,
        locationId: conexion.locationId,
        channel: conexion.channel,
        externalRef,
        reason: motivo,
        rawPayload: evento.payload,
        traceId,
      });
      return { orderId: pedido.id, aparted: true };
    };

    let normalizado;
    try {
      normalizado = connector.parseOrder(evento.payload);
    } catch (error) {
      if (error instanceof ConnectorParseError) {
        return aBandeja(`Payload no interpretable: ${error.message}`);
      }
      throw error;
    }

    // Mapeo de catálogo (RN-INT-02). Se recogen TODOS los SKUs sin mapear, no
    // solo el primero: quien resuelva la excepción necesita la lista completa
    // para arreglarlo de una vez.
    const mapa = await withTenant(this.pool, evento.tenant_id, (ctx) =>
      this.connections.loadCatalogMap(ctx, evento.connection_id),
    );

    const sinMapear: string[] = [];
    const lines: SubmitLineInput[] = [];
    for (const linea of normalizado.lines) {
      const destino = mapa.get(linea.externalSku);
      if (!destino?.productId) {
        sinMapear.push(linea.externalSku);
        continue;
      }
      const opciones: string[] = [];
      for (const modSku of linea.modifierSkus) {
        const mod = mapa.get(modSku);
        if (!mod?.modifierOptionId) {
          sinMapear.push(modSku);
          continue;
        }
        opciones.push(mod.modifierOptionId);
      }
      lines.push({
        productId: destino.productId,
        quantity: linea.quantity,
        modifierOptionIds: opciones,
        notes: linea.notes,
      });
    }

    if (sinMapear.length > 0) {
      return aBandeja(
        `SKUs externos sin mapear: ${[...new Set(sinMapear)].join(', ')}`,
      );
    }

    try {
      const pedido = await this.ordering.submit(evento.tenant_id, {
        brandId: conexion.brandId,
        locationId: conexion.locationId,
        channel: conexion.channel,
        externalRef,
        lines,
        customerName: normalizado.customerName,
        customerPhone: normalizado.customerPhone,
        delivery: normalizado.delivery,
        tipMinor: normalizado.tipMinor,
        scheduledAt: normalizado.scheduledAt,
        notes: normalizado.notes,
        traceId,
      });
      return { orderId: pedido.id, aparted: false };
    } catch (error) {
      // Fuera de cobertura, producto no disponible, bajo el mínimo, modificador
      // obligatorio sin elegir... El canal ya le prometió la comida a alguien:
      // la decisión de rechazar es del negocio, con el pedido delante, no de un
      // catch.
      //
      // Los errores de `@sahana/domain` (`ModifierError`, `PricingError`) NO
      // heredan de `DomainError`, que es la jerarquía de la API. Cuando el
      // `catch` solo miraba `DomainError`, un pedido de marketplace con un
      // grupo obligatorio sin elegir se escapaba por la vía de los fallos
      // TRANSITORIOS: se reintentaba cinco veces contra un payload que jamás
      // iba a mejorar y acababa en la cola de muertos en lugar de en la
      // bandeja de excepciones. Eso rompe RN-INT-02 y el criterio de T4.13
      // —«webhook aceptado → pedido o `needs_review`, nunca otra cosa»— y lo
      // destapó la prueba de carga: 133 envíos en `failed` con el mismo texto.
      const atribuibleAlContenido =
        error instanceof DomainError ||
        error instanceof ModifierError ||
        error instanceof PricingError;

      if (atribuibleAlContenido) {
        const motivo =
          error instanceof DomainError ? error.detail : error.message;
        return aBandeja(`Pedido rechazado por validación: ${motivo}`);
      }
      throw error;
    }
  }

  private async loadConnection(
    tenantId: string,
    connectionId: string,
  ): Promise<Pick<ResolvedConnection, 'brandId' | 'locationId' | 'channel'>> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        brand_id: string;
        location_id: string;
        channel: string;
      }>(
        'SELECT brand_id, location_id, channel FROM int_connections WHERE id = $1',
        [connectionId],
      );
      const row = rows[0];
      if (!row) {
        throw new Error(
          `La conexión ${connectionId} desapareció mientras se procesaba su webhook.`,
        );
      }
      return {
        brandId: row.brand_id,
        locationId: row.location_id,
        channel: row.channel,
      };
    });
  }

  /** Envíos que ni siquiera pudieron apartarse. Debe estar vacía. */
  async deadLetters(tenantId: string): Promise<
    Array<{
      id: string;
      provider: string;
      deliveryId: string;
      attempts: number;
      lastError: string | null;
      receivedAt: string;
    }>
  > {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        provider: string;
        delivery_id: string;
        attempts: number;
        last_error: string | null;
        received_at: Date;
      }>(
        `SELECT id, provider, delivery_id, attempts, last_error, received_at
           FROM int_webhook_events
          WHERE status = 'failed'
          ORDER BY received_at DESC
          LIMIT 200`,
      );
      return rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        deliveryId: r.delivery_id,
        attempts: r.attempts,
        lastError: r.last_error,
        receivedAt: r.received_at.toISOString(),
      }));
    });
  }

  /** Devuelve a la cola un envío de la cola de muertos, tras arreglar la causa. */
  async retryDeadLetter(tenantId: string, eventId: string): Promise<void> {
    await withTenant(this.pool, tenantId, async ({ client }) => {
      await client.query(
        `UPDATE int_webhook_events SET status = 'pending', attempts = 0, last_error = NULL
          WHERE id = $1 AND status = 'failed'`,
        [eventId],
      );
    });
  }

  /**
   * Solo cabeceras útiles para diagnosticar. Guardar el juego completo
   * arrastraría a la BD cualquier `authorization` que mande el proveedor.
   */
  private safeHeaders(headers: WebhookHeaders): Record<string, string> {
    const permitidas = [
      'content-type',
      'user-agent',
      'x-sahana-delivery-id',
      'x-request-id',
    ];
    const out: Record<string, string> = {};
    for (const k of permitidas) {
      const v = headers[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
}
