import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  BillingService,
  type DocumentStatus,
  type DocumentView,
} from '../app/billing.service.js';

/**
 * Facturación (spec 10 §API).
 *
 * `POST /documents` es interno —lo llama Ordering o el POS al cobrar— pero se
 * expone igualmente: en una venta al mostrador el cajero decide boleta o
 * factura DESPUÉS de cobrar, cuando el cliente saca su RUC del bolsillo.
 */

const documentoSchema = z.object({
  orderId: z.string().uuid(),
  docType: z.enum(['DNI', 'RUC', 'CE', 'PASAPORTE', 'NONE']),
  docNumber: z.string().min(1).optional(),
  legalName: z.string().min(1).optional(),
  /**
   * Fecha de emisión real. La manda el POS en una venta offline, y puede ser
   * de hace horas: contra ella corre el plazo de SUNAT (RN-BIL-03).
   */
  issuedAt: z.string().datetime().optional(),
});

const notaCreditoSchema = z.object({
  reason: z.string().min(3, 'Una nota de crédito necesita un motivo.'),
});

const ESTADOS = [
  'queued',
  'numbered',
  'accepted',
  'rejected',
  'voided',
] as const;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => i.message).join(' '),
      { errors: result.error.issues },
    );
  }
  return result.data;
}

@Controller({ path: 'documents', version: '1' })
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @RequirePermission('billing.read')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
  ): Promise<DocumentView[]> {
    if (status && !ESTADOS.includes(status as DocumentStatus)) {
      throw new ValidationError(
        `Estado desconocido: "${status}". Usa uno de: ${ESTADOS.join(', ')}.`,
      );
    }
    return this.billing.list(req.auth!.tid, {
      ...(status ? { status: status as DocumentStatus } : {}),
    });
  }

  @Get(':id')
  @RequirePermission('billing.read')
  get(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<DocumentView> {
    return this.billing.get(req.auth!.tid, id);
  }

  /**
   * Crea el comprobante y lo deja en cola. NO espera al OSE: si esperara, un
   * corte de internet dejaría al cajero mirando una rueda con el cliente
   * delante.
   */
  @Post()
  @RequirePermission('billing.issue')
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DocumentView> {
    const dto = parse(documentoSchema, body);
    return this.billing.createForOrder(
      req.auth!.tid,
      dto.orderId,
      {
        docType: dto.docType,
        docNumber: dto.docNumber,
        legalName: dto.legalName,
      },
      {
        ...(dto.issuedAt ? { issuedAt: new Date(dto.issuedAt) } : {}),
        ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
      },
    );
  }

  /**
   * Fuerza el envío de un documento pendiente o rechazado.
   *
   * Existe para la cola de corrección (RN-BIL-02): alguien arregla el dato y
   * pide reenviar sin esperar a la siguiente vuelta del worker.
   */
  @Post(':id/retry')
  @RequirePermission('billing.issue')
  retry(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<DocumentView> {
    return this.billing.issue(req.auth!.tid, id, {
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  /**
   * Anula un comprobante aceptado con una nota de crédito.
   *
   * Nunca se borra ni se edita un comprobante emitido: ya está declarado. Se
   * emite otro que lo revierte.
   */
  @Post(':id/credit-note')
  @RequirePermission('billing.void')
  creditNote(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DocumentView> {
    const dto = parse(notaCreditoSchema, body);
    return this.billing.issueCreditNote(req.auth!.tid, id, {
      reason: dto.reason,
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }
}
