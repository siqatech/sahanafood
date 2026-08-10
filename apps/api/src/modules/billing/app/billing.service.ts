import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  resolveDocumentType,
  assertValidIdentity,
  formatDocumentNumber,
  checkDeferredIssuance,
  DEFAULT_DEFERRAL_POLICY,
  BillingError as DomainBillingError,
  type CustomerIdentity,
  type DocumentType,
  type DeferralPolicy,
} from '@sahana/domain';
import {
  withTenant,
  withSystem,
  type TenantContext,
} from '../../../database/rls.js';
import { PG_POOL } from '../../../database/database.module.js';
import { recordAudit } from '../../audit/index.js';
import { enqueueEvent } from '../../../events/outbox.js';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';
import type {
  BillingProvider,
  SubmissionDocument,
  SubmissionOutcome,
} from '../domain/billing-provider.js';
import { BILLING_PROVIDER } from '../billing.tokens.js';

/**
 * Facturación electrónica (spec 10, T4.26/T4.27, ADR-0003).
 *
 * Todo el módulo gira alrededor de una frase de RN-BIL-01: **el correlativo se
 * toma al emitir, no al encolar**, y no puede haber huecos.
 *
 * Suena a detalle contable y no lo es. Un hueco en la numeración —el 41 y el
 * 43 emitidos, el 42 en ninguna parte— hay que justificarlo ante SUNAT con una
 * comunicación de baja. Si eso pasa cada vez que se cae el internet, el
 * contador del cliente acaba con una lista de bajas que explicar cada mes.
 *
 * La forma que evita los huecos es esta:
 *
 * 1. El documento **nace sin número** (`queued`). Una venta siempre genera su
 *    documento, aunque no haya red.
 * 2. El número se asigna **bloqueando la fila de la serie**, y en ese mismo
 *    momento se persiste en el documento. Dos cajas cobrando a la vez se
 *    serializan ahí.
 * 3. Una vez asignado, ese número **es de ese documento para siempre**. Los
 *    reintentos reenvían el mismo. Nunca se «devuelve» un número al pozo:
 *    devolverlo es justo lo que crea el hueco cuando el reintento sí funciona.
 */

export class SeriesNotConfiguredError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/series-not-configured';
  readonly title = 'Serie no configurada';
  override readonly code = 'BILLING_SERIES_NOT_CONFIGURED';
}

export class DocumentAlreadyIssuedError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/document-already-issued';
  readonly title = 'La venta ya tiene comprobante';
  override readonly code = 'BILLING_ALREADY_ISSUED';
}

export class InvalidCustomerIdentityError extends ValidationError {
  override readonly code = 'BILLING_CUSTOMER_INVALID';
}

export type DocumentStatus =
  'queued' | 'numbered' | 'accepted' | 'rejected' | 'voided';

export interface DocumentView {
  id: string;
  orderId: string | null;
  docType: DocumentType;
  number: string | null;
  status: DocumentStatus;
  total: string;
  currency: string;
  issuedAt: string;
  acceptedAt: string | null;
  rejectionCode: string | null;
  rejectionReason: string | null;
  attempts: number;
  /**
   * A nombre de quién va. Se devuelve porque **no se puede corregir lo que no
   * se ve**: la cola de corrección existe justo para arreglar estos tres
   * campos, y sin ellos la pantalla pediría escribirlos a ciegas.
   */
  customerDocType: string;
  customerDocNumber: string | null;
  customerName: string | null;
  /** Cómo va de plazo si sigue pendiente (RN-BIL-03). */
  deferral?:
    | { status: 'ok' | 'warning' | 'expired'; hoursRemaining: number }
    | undefined;
}

interface FilaDocumento {
  id: string;
  company_id: string;
  order_id: string | null;
  doc_type: DocumentType;
  series_id: string | null;
  series: string | null;
  correlative: number | null;
  number: string | null;
  status: DocumentStatus;
  customer_doc_type: string;
  customer_doc_number: string | null;
  customer_name: string | null;
  subtotal: string;
  taxable_base: string;
  tax: string;
  total: string;
  currency: string;
  lines: Array<{
    description: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
  }>;
  issued_at: Date;
  accepted_at: Date | null;
  rejection_code: string | null;
  rejection_reason: string | null;
  provider_ticket: string | null;
  attempts: number;
  references_id: string | null;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  // -------------------------------------------------------------------------
  // Creación del documento
  // -------------------------------------------------------------------------

  /**
   * Crea el comprobante de una venta y lo deja EN COLA, sin número.
   *
   * No emite: encolar y emitir son dos cosas distintas a propósito (RN-BIL-01).
   * Una venta sin red tiene que poder cobrarse y dejar su documento pendiente;
   * si crear el documento dependiera de que el OSE conteste, un corte de
   * internet pararía la caja.
   */
  async createForOrder(
    tenantId: string,
    orderId: string,
    identidad: CustomerIdentity,
    options: { ctx?: TenantContext; issuedAt?: Date; traceId?: string } = {},
  ): Promise<DocumentView> {
    try {
      assertValidIdentity(identidad);
    } catch (error) {
      if (error instanceof DomainBillingError) {
        throw new InvalidCustomerIdentityError(error.message, {
          code: error.code,
        });
      }
      throw error;
    }

    const ejecutar = async (ctx: TenantContext): Promise<DocumentView> => {
      const pedido = await this.cargarPedido(ctx, orderId);

      const { rows: existente } = await ctx.client.query<FilaDocumento>(
        `SELECT * FROM bil_documents
          WHERE order_id = $1 AND doc_type <> 'nota_credito'`,
        [orderId],
      );
      if (existente[0]) {
        // Facturar dos veces la misma venta es peor que no facturarla: obliga
        // a anular con nota de crédito y a explicar por qué se emitió.
        throw new DocumentAlreadyIssuedError(
          `La venta ya tiene el comprobante ${existente[0].number ?? '(en cola)'}.`,
        );
      }

      const tipo = resolveDocumentType(identidad);
      const lineas = await this.cargarLineas(ctx, orderId);

      const { rows } = await ctx.client.query<FilaDocumento>(
        `INSERT INTO bil_documents
           (tenant_id, company_id, order_id, doc_type,
            customer_doc_type, customer_doc_number, customer_name,
            subtotal, taxable_base, tax, total, currency, tax_rate_bps,
            lines, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
         RETURNING *`,
        [
          ctx.tenantId,
          pedido.company_id,
          orderId,
          tipo,
          identidad.docType,
          identidad.docNumber ?? null,
          identidad.legalName ?? pedido.customer_name ?? null,
          pedido.subtotal,
          pedido.taxable_base,
          pedido.tax,
          pedido.total,
          pedido.currency,
          pedido.tax_rate_bps,
          JSON.stringify(lineas),
          // La fecha de emisión es la de la VENTA (RN-BIL-03). En una venta
          // offline llega de la caja y puede ser de hace horas: es contra esa
          // que corre el plazo de SUNAT, no contra el momento del envío.
          options.issuedAt ?? pedido.closed_at ?? new Date(),
        ],
      );

      await enqueueEvent(ctx, {
        aggregateType: 'document',
        aggregateId: rows[0]!.id,
        eventType: 'billing.document_queued',
        payload: { documentId: rows[0]!.id, orderId, docType: tipo },
        ...(options.traceId ? { traceId: options.traceId } : {}),
      });

      return this.aVista(rows[0]!);
    };

    return options.ctx
      ? ejecutar(options.ctx)
      : withTenant(this.pool, tenantId, ejecutar);
  }

  // -------------------------------------------------------------------------
  // Numeración — el corazón de RN-BIL-01
  // -------------------------------------------------------------------------

  /**
   * Asigna serie y correlativo, en su propia transacción.
   *
   * `FOR UPDATE` sobre la fila de la serie. Es lo que serializa a dos cajas
   * cobrando a la vez: la segunda espera a que la primera confirme, y se lleva
   * el número siguiente. Sin ese bloqueo, ambas leerían el mismo
   * `last_correlative` y emitirían el mismo comprobante — un duplicado ante
   * SUNAT, no un choque de claves.
   *
   * Si el documento YA tiene número, se devuelve el suyo. Es lo que hace que
   * un reintento no consuma un número nuevo: consumir uno por intento es
   * exactamente cómo se producen los huecos.
   */
  private async asignarNumero(
    ctx: TenantContext,
    documento: FilaDocumento,
  ): Promise<FilaDocumento> {
    if (documento.number) return documento;

    const { rows: series } = await ctx.client.query<{
      id: string;
      series: string;
      last_correlative: number;
    }>(
      `SELECT id, series, last_correlative
         FROM bil_series
        WHERE company_id = $1 AND doc_type = $2 AND is_active
        FOR UPDATE`,
      [documento.company_id, documento.doc_type],
    );

    const serie = series[0];
    if (!serie) {
      throw new SeriesNotConfiguredError(
        `No hay serie activa de ${documento.doc_type} para esta empresa. Configúrala antes de emitir.`,
      );
    }

    const correlativo = serie.last_correlative + 1;
    const numero = formatDocumentNumber(serie.series, correlativo);

    await ctx.client.query(
      `UPDATE bil_series SET last_correlative = $1 WHERE id = $2`,
      [correlativo, serie.id],
    );

    const { rows } = await ctx.client.query<FilaDocumento>(
      `UPDATE bil_documents
          SET series_id = $1, series = $2, correlative = $3, number = $4,
              status = 'numbered', updated_at = now()
        WHERE id = $5
        RETURNING *`,
      [serie.id, serie.series, correlativo, numero, documento.id],
    );

    return rows[0]!;
  }

  // -------------------------------------------------------------------------
  // Emisión
  // -------------------------------------------------------------------------

  /**
   * Numera si hace falta y manda el documento al OSE.
   *
   * La numeración va en SU PROPIA transacción, corta, y el envío ocurre fuera:
   * mantener abierta una transacción mientras se espera a un tercero bloquea
   * la fila de la serie durante todo el viaje de red, y con ella a todas las
   * cajas del tenant. Un OSE lento pararía las ventas.
   */
  /**
   * Corrige los datos del cliente de un comprobante RECHAZADO y lo reenvía.
   *
   * Es la mitad que faltaba de RN-BIL-02. La regla dice «documento rechazado
   * por OSE → **cola de corrección**», y la cola existía: el documento quedaba
   * en `rejected` con el motivo del OSE al lado, y la pantalla de operaciones
   * decía «hay que corregir y reenviar». **Corregir no se podía.** Lo único
   * expuesto era reenviar, que manda otra vez exactamente el mismo RUC que el
   * OSE acaba de rechazar, y `createForOrder` se niega a crear otro porque la
   * venta ya tiene comprobante. La venta no se perdía —eso sí lo cumplía— pero
   * se quedaba sin poder facturarse, que ante SUNAT es igual de malo.
   *
   * **Se conserva el número.** Un comprobante rechazado nunca fue válido, así
   * que reenviarlo corregido con su mismo correlativo es lo correcto; darle uno
   * nuevo dejaría el anterior como un hueco en la serie, y un hueco hay que
   * justificarlo con una comunicación de baja.
   *
   * **Solo desde `rejected`.** Uno aceptado ya está declarado y se revierte con
   * nota de crédito, no editándolo; uno en cola todavía no ha ido a ningún
   * sitio y se corrige antes de emitirlo.
   */
  async correctCustomer(
    tenantId: string,
    documentId: string,
    identidad: CustomerIdentity,
    options: { actorId?: string | undefined; traceId?: string } = {},
  ): Promise<DocumentView> {
    try {
      assertValidIdentity(identidad);
    } catch (error) {
      if (error instanceof DomainBillingError) {
        throw new InvalidCustomerIdentityError(error.message, {
          code: error.code,
        });
      }
      throw error;
    }

    await withTenant(this.pool, tenantId, async (ctx) => {
      const fila = await this.cargarDocumento(ctx, documentId);
      if (fila.status !== 'rejected') {
        throw new ValidationError(
          `Solo se corrigen los comprobantes rechazados; este está en "${fila.status}".`,
        );
      }

      const tipo = resolveDocumentType(identidad);
      if (tipo !== fila.doc_type) {
        // Boleta y factura son series distintas y correlativos distintos. Pasar
        // de una a otra no es corregir un dato: es otro comprobante, y este hay
        // que darlo de baja antes.
        throw new ValidationError(
          `Cambiar de ${fila.doc_type} a ${tipo} no es una corrección: son series distintas. Da de baja este comprobante y emite el otro.`,
        );
      }

      await ctx.client.query(
        `UPDATE bil_documents
            SET customer_doc_type = $2, customer_doc_number = $3,
                customer_name = $4, updated_at = now()
          WHERE id = $1`,
        [
          documentId,
          identidad.docType,
          identidad.docNumber ?? null,
          identidad.legalName ?? fila.customer_name,
        ],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
        action: 'billing.customer_corrected',
        resourceType: 'document',
        resourceId: documentId,
        // El motivo del rechazo queda al lado del dato nuevo: es lo que hace
        // legible la corrección tres meses después, cuando el contador
        // pregunta por qué este comprobante lleva dos identidades.
        data: {
          rejectionCode: fila.rejection_code,
          from: {
            docType: fila.customer_doc_type,
            docNumber: fila.customer_doc_number,
          },
          to: {
            docType: identidad.docType,
            docNumber: identidad.docNumber ?? null,
          },
        },
        ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
      });
    });

    return this.issue(tenantId, documentId, {
      ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
    });
  }

  async issue(
    tenantId: string,
    documentId: string,
    options: { traceId?: string } = {},
  ): Promise<DocumentView> {
    const documento = await withTenant(this.pool, tenantId, async (ctx) => {
      const fila = await this.cargarDocumento(ctx, documentId);
      if (fila.status === 'accepted' || fila.status === 'voided') return fila;
      return this.asignarNumero(ctx, fila);
    });

    if (documento.status === 'accepted' || documento.status === 'voided') {
      return this.aVista(documento);
    }

    return this.enviar(tenantId, documento, options.traceId);
  }

  /**
   * Envía al OSE y registra el desenlace.
   *
   * Antes de reenviar un documento del que no se supo nada, se PREGUNTA por su
   * ticket. Es el caso que produce comprobantes duplicados en los sistemas que
   * no lo contemplan: se manda, se pierde la respuesta, se reenvía, y el OSE
   * ya lo tenía.
   */
  private async enviar(
    tenantId: string,
    documento: FilaDocumento,
    traceId?: string,
  ): Promise<DocumentView> {
    const emisor = await this.cargarEmisor(tenantId, documento.company_id);
    const carga = this.aCargaDeEnvio(documento, emisor);

    const inicio = Date.now();
    let resultado: SubmissionOutcome;

    if (documento.provider_ticket) {
      // Hubo un envío anterior sin desenlace conocido: se consulta en vez de
      // reenviar a ciegas.
      resultado = await this.provider.status(documento.provider_ticket);
      if (resultado.kind === 'error') {
        resultado = await this.provider.submit(carga);
      }
    } else {
      resultado = await this.provider.submit(carga);
    }

    const latencia = Date.now() - inicio;

    return withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.client.query(
        `INSERT INTO bil_submissions
           (tenant_id, document_id, attempt, outcome, provider,
            request, response, error_message, latency_ms, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
        [
          ctx.tenantId,
          documento.id,
          documento.attempts + 1,
          resultado.kind === 'accepted'
            ? 'accepted'
            : resultado.kind === 'rejected'
              ? 'rejected'
              : 'error',
          this.provider.name,
          JSON.stringify(carga),
          JSON.stringify(
            resultado.kind === 'error'
              ? { message: resultado.message }
              : resultado.raw,
          ),
          resultado.kind === 'error' ? resultado.message : null,
          latencia,
          traceId ?? null,
        ],
      );

      const actualizado = await this.aplicarResultado(
        ctx,
        documento,
        resultado,
        traceId,
      );
      return this.aVista(actualizado);
    });
  }

  private async aplicarResultado(
    ctx: TenantContext,
    documento: FilaDocumento,
    resultado: SubmissionOutcome,
    traceId?: string,
  ): Promise<FilaDocumento> {
    if (resultado.kind === 'accepted') {
      const { rows } = await ctx.client.query<FilaDocumento>(
        `UPDATE bil_documents
            SET status = 'accepted', accepted_at = now(), sent_at = now(),
                provider = $1, provider_ticket = $2, provider_response = $3::jsonb,
                rejection_code = NULL, rejection_reason = NULL,
                attempts = attempts + 1, next_attempt_at = NULL, updated_at = now()
          WHERE id = $4
          RETURNING *`,
        [
          this.provider.name,
          resultado.ticket,
          JSON.stringify(resultado.raw),
          documento.id,
        ],
      );
      await enqueueEvent(ctx, {
        aggregateType: 'document',
        aggregateId: documento.id,
        eventType: 'billing.document_accepted',
        payload: {
          documentId: documento.id,
          orderId: documento.order_id,
          number: rows[0]!.number,
        },
        ...(traceId ? { traceId } : {}),
      });
      return rows[0]!;
    }

    if (resultado.kind === 'rejected') {
      // RN-BIL-02: a la cola de corrección con alerta. NUNCA se pierde la
      // venta — el documento sigue ahí, con su número y su motivo.
      const { rows } = await ctx.client.query<FilaDocumento>(
        `UPDATE bil_documents
            SET status = 'rejected', sent_at = now(),
                provider = $1, provider_response = $2::jsonb,
                rejection_code = $3, rejection_reason = $4,
                attempts = attempts + 1, next_attempt_at = NULL, updated_at = now()
          WHERE id = $5
          RETURNING *`,
        [
          this.provider.name,
          JSON.stringify(resultado.raw),
          resultado.code,
          resultado.reason,
          documento.id,
        ],
      );
      await enqueueEvent(ctx, {
        aggregateType: 'document',
        aggregateId: documento.id,
        eventType: 'billing.document_rejected',
        payload: {
          documentId: documento.id,
          orderId: documento.order_id,
          code: resultado.code,
          reason: resultado.reason,
        },
        ...(traceId ? { traceId } : {}),
      });
      this.logger.warn(
        `Comprobante ${rows[0]!.number} rechazado por el OSE (${resultado.code}): ${resultado.reason}`,
      );
      return rows[0]!;
    }

    // Error transitorio: se conserva el número y se programa el reintento con
    // backoff. El documento NO vuelve a `queued`: eso le devolvería el número
    // al pozo y crearía el hueco que RN-BIL-01 prohíbe.
    const intentos = documento.attempts + 1;
    const esperaMs = Math.min(2 ** Math.min(intentos, 8) * 1_000, 15 * 60_000);
    const { rows } = await ctx.client.query<FilaDocumento>(
      `UPDATE bil_documents
          SET attempts = $1, sent_at = now(), provider = $2,
              next_attempt_at = now() + ($3 || ' milliseconds')::interval,
              updated_at = now()
        WHERE id = $4
        RETURNING *`,
      [intentos, this.provider.name, String(esperaMs), documento.id],
    );
    return rows[0]!;
  }

  // -------------------------------------------------------------------------
  // Cola diferida (RN-BIL-03)
  // -------------------------------------------------------------------------

  /**
   * Procesa la cola pendiente, lo más antiguo primero.
   *
   * El orden importa: la tentación es despachar lo que acaba de entrar —es lo
   * que el operador está mirando— y es al revés. El documento viejo es el
   * único que puede vencer el plazo de SUNAT; el nuevo tiene 72 horas por
   * delante.
   */
  async processQueue(
    tenantId: string,
    options: { limit?: number; policy?: DeferralPolicy; traceId?: string } = {},
  ): Promise<{
    processed: number;
    accepted: number;
    failed: number;
    expiring: number;
  }> {
    const politica = options.policy ?? DEFAULT_DEFERRAL_POLICY;

    const pendientes = await withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<FilaDocumento>(
        `SELECT * FROM bil_documents
          WHERE status IN ('queued','numbered')
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY issued_at
          LIMIT $1`,
        [options.limit ?? 50],
      );
      return rows;
    });

    const resumen = { processed: 0, accepted: 0, failed: 0, expiring: 0 };

    for (const pendiente of pendientes) {
      const plazo = checkDeferredIssuance(
        pendiente.issued_at,
        new Date(),
        politica,
      );
      if (plazo.status !== 'ok') {
        resumen.expiring++;
        await this.avisarPlazo(
          tenantId,
          pendiente,
          plazo.status,
          plazo.hoursRemaining,
        );
      }

      const vista = await this.issue(tenantId, pendiente.id, {
        ...(options.traceId ? { traceId: options.traceId } : {}),
      });
      resumen.processed++;
      if (vista.status === 'accepted') resumen.accepted++;
      else resumen.failed++;
    }

    return resumen;
  }

  /**
   * Avisa de que un comprobante se está quedando sin plazo.
   *
   * El aviso sale UNA vez por documento y estado: repetirlo en cada vuelta del
   * worker convertiría la alerta en ruido, y una alerta que suena cada minuto
   * es una alerta que se silencia.
   */
  private async avisarPlazo(
    tenantId: string,
    documento: FilaDocumento,
    estado: 'warning' | 'expired',
    horasRestantes: number,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox
          WHERE aggregate_id = $1 AND event_type = 'billing.deferral_alert'
            AND payload->>'level' = $2`,
        [documento.id, estado],
      );
      if (Number(rows[0]?.n ?? 0) > 0) return;

      await enqueueEvent(ctx, {
        aggregateType: 'document',
        aggregateId: documento.id,
        eventType: 'billing.deferral_alert',
        payload: {
          documentId: documento.id,
          orderId: documento.order_id,
          level: estado,
          hoursRemaining: Math.round(horasRestantes * 10) / 10,
          number: documento.number,
        },
      });
    });
  }

  /**
   * Vacía la cola de TODOS los tenants. Lo llama el worker.
   *
   * Sin esto, `processQueue` sería una función que solo corre en las pruebas —
   * y en producción los comprobantes de una venta offline se quedarían en cola
   * hasta que alguien pulsara «reintentar» a mano, uno por uno.
   *
   * Un tenant que falla no puede parar a los demás: su error se registra y se
   * sigue. La facturación de un local no depende de la conectividad de otro.
   */
  async processQueueAllTenants(
    options: { limitPerTenant?: number } = {},
  ): Promise<{
    tenants: number;
    processed: number;
    accepted: number;
    expiring: number;
  }> {
    const tenants = await withSystem(this.pool, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM ten_tenants WHERE status = 'active'`,
      );
      return rows.map((r) => r.id);
    });

    const total = { tenants: 0, processed: 0, accepted: 0, expiring: 0 };
    for (const tenantId of tenants) {
      try {
        const r = await this.processQueue(tenantId, {
          limit: options.limitPerTenant ?? 50,
        });
        total.tenants++;
        total.processed += r.processed;
        total.accepted += r.accepted;
        total.expiring += r.expiring;
      } catch (error) {
        this.logger.error(
          `Cola de facturación fallida para el tenant ${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Nota de crédito
  // -------------------------------------------------------------------------

  /**
   * Anula un comprobante ya aceptado emitiendo una nota de crédito.
   *
   * Nunca se borra ni se edita un comprobante emitido: ya está declarado. Se
   * emite otro que lo revierte, con su propio correlativo y su referencia al
   * original.
   */
  async issueCreditNote(
    tenantId: string,
    documentId: string,
    datos: { reason: string; actorId?: string; traceId?: string },
  ): Promise<DocumentView> {
    if (!datos.reason?.trim()) {
      throw new ValidationError('Una nota de crédito necesita un motivo.');
    }

    const nota = await withTenant(this.pool, tenantId, async (ctx) => {
      const original = await this.cargarDocumento(ctx, documentId);
      if (original.status !== 'accepted') {
        throw new ValidationError(
          `Solo se puede anular un comprobante aceptado; este está en "${original.status}".`,
        );
      }
      if (original.doc_type === 'nota_credito') {
        throw new ValidationError('Una nota de crédito no se anula con otra.');
      }

      const { rows } = await ctx.client.query<FilaDocumento>(
        `INSERT INTO bil_documents
           (tenant_id, company_id, order_id, doc_type,
            customer_doc_type, customer_doc_number, customer_name,
            subtotal, taxable_base, tax, total, currency, tax_rate_bps,
            lines, references_id, issued_at)
         SELECT tenant_id, company_id, order_id, 'nota_credito',
                customer_doc_type, customer_doc_number, customer_name,
                subtotal, taxable_base, tax, total, currency, tax_rate_bps,
                lines, id, now()
           FROM bil_documents WHERE id = $1
         RETURNING *`,
        [documentId],
      );

      await ctx.client.query(
        `UPDATE bil_documents SET status = 'voided', updated_at = now()
          WHERE id = $1`,
        [documentId],
      );

      await recordAudit(ctx, {
        actorType: datos.actorId ? 'user' : 'system',
        ...(datos.actorId ? { actorId: datos.actorId } : {}),
        action: 'invoice.credit_note',
        resourceType: 'document',
        resourceId: documentId,
        reason: datos.reason,
        data: { creditNoteId: rows[0]!.id, original: original.number },
        ...(datos.traceId ? { traceId: datos.traceId } : {}),
      });

      return rows[0]!;
    });

    return this.issue(tenantId, nota.id, {
      ...(datos.traceId ? { traceId: datos.traceId } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  async list(
    tenantId: string,
    filtros: { status?: DocumentStatus; limit?: number } = {},
  ): Promise<DocumentView[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<FilaDocumento>(
        `SELECT * FROM bil_documents
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY issued_at DESC
          LIMIT $2`,
        [filtros.status ?? null, filtros.limit ?? 100],
      );
      return rows.map((r) => this.aVista(r));
    });
  }

  async get(tenantId: string, documentId: string): Promise<DocumentView> {
    return withTenant(this.pool, tenantId, async (ctx) =>
      this.aVista(await this.cargarDocumento(ctx, documentId)),
    );
  }

  // -------------------------------------------------------------------------
  // Auxiliares
  // -------------------------------------------------------------------------

  private async cargarDocumento(
    ctx: TenantContext,
    documentId: string,
  ): Promise<FilaDocumento> {
    const { rows } = await ctx.client.query<FilaDocumento>(
      `SELECT * FROM bil_documents WHERE id = $1`,
      [documentId],
    );
    if (!rows[0]) {
      // Sin repetir el id: si viene de otro tenant, la respuesta llevaría un
      // dato ajeno.
      throw new NotFoundError(
        'No existe ese comprobante, o no pertenece a este tenant.',
      );
    }
    return rows[0];
  }

  private async cargarPedido(
    ctx: TenantContext,
    orderId: string,
  ): Promise<{
    company_id: string;
    customer_name: string | null;
    subtotal: string;
    taxable_base: string;
    tax: string;
    total: string;
    currency: string;
    tax_rate_bps: number;
    closed_at: Date | null;
  }> {
    const { rows } = await ctx.client.query<{
      company_id: string;
      customer_name: string | null;
      subtotal: string;
      taxable_base: string;
      tax: string;
      total: string;
      currency: string;
      tax_rate_bps: number;
      closed_at: Date | null;
    }>(
      `SELECT c.id AS company_id, o.customer_name, o.subtotal, o.taxable_base,
              o.tax, o.total, o.currency, o.tax_rate_bps, o.closed_at
         FROM ord_orders o
         JOIN org_locations l ON l.id = o.location_id
         JOIN org_companies c ON c.id = l.company_id
        WHERE o.id = $1`,
      [orderId],
    );
    if (!rows[0]) {
      throw new NotFoundError(
        'No existe ese pedido, o no pertenece a este tenant.',
      );
    }
    return rows[0];
  }

  private async cargarLineas(
    ctx: TenantContext,
    orderId: string,
  ): Promise<
    Array<{
      description: string;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
    }>
  > {
    const { rows } = await ctx.client.query<{
      product_name: string;
      quantity: number;
      unit_price: string;
      line_total: string;
    }>(
      `SELECT product_name, quantity, unit_price, line_total
         FROM ord_order_lines WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    );
    return rows.map((r) => ({
      description: r.product_name,
      quantity: r.quantity,
      unitPrice: r.unit_price,
      lineTotal: r.line_total,
    }));
  }

  private async cargarEmisor(
    tenantId: string,
    companyId: string,
  ): Promise<{ taxId: string; legalName: string }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        tax_id: string;
        legal_name: string;
      }>(`SELECT tax_id, legal_name FROM org_companies WHERE id = $1`, [
        companyId,
      ]);
      if (!rows[0]) {
        throw new NotFoundError('No existe la empresa emisora.');
      }
      return { taxId: rows[0].tax_id, legalName: rows[0].legal_name };
    });
  }

  private aCargaDeEnvio(
    documento: FilaDocumento,
    emisor: { taxId: string; legalName: string },
  ): SubmissionDocument {
    return {
      documentId: documento.id,
      docType: documento.doc_type,
      series: documento.series!,
      correlative: documento.correlative!,
      number: documento.number!,
      issuedAt: documento.issued_at,
      issuer: emisor,
      customer: {
        docType: documento.customer_doc_type,
        docNumber: documento.customer_doc_number ?? undefined,
        name: documento.customer_name ?? undefined,
      },
      subtotal: documento.subtotal,
      taxableBase: documento.taxable_base,
      tax: documento.tax,
      total: documento.total,
      currency: documento.currency,
      lines: documento.lines,
    };
  }

  private aVista(fila: FilaDocumento): DocumentView {
    const pendiente = fila.status === 'queued' || fila.status === 'numbered';
    const plazo = pendiente
      ? checkDeferredIssuance(fila.issued_at, new Date())
      : null;

    return {
      id: fila.id,
      orderId: fila.order_id,
      docType: fila.doc_type,
      number: fila.number,
      status: fila.status,
      // Se devuelve tal cual viene de NUMERIC: pasarlo por `Number` para
      // formatearlo lo metería en coma flotante justo antes de enseñárselo a
      // alguien que lo va a declarar.
      total: fila.total,
      currency: fila.currency,
      issuedAt: fila.issued_at.toISOString(),
      acceptedAt: fila.accepted_at?.toISOString() ?? null,
      rejectionCode: fila.rejection_code,
      rejectionReason: fila.rejection_reason,
      attempts: fila.attempts,
      customerDocType: fila.customer_doc_type,
      customerDocNumber: fila.customer_doc_number,
      customerName: fila.customer_name,
      ...(plazo
        ? {
            deferral: {
              status: plazo.status,
              hoursRemaining: Math.round(plazo.hoursRemaining * 10) / 10,
            },
          }
        : {}),
    };
  }
}
