import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ValidationError } from '../../../common/errors.js';
import { IngestionService, type AckResult } from '../app/ingestion.service.js';
import type { WebhookHeaders } from '../domain/channel-connector.js';

/**
 * Entrada de webhooks de marketplace (spec 13, RN-INT-01).
 *
 * SIN `@RequirePermission` a propósito: quien llama es Rappi, no un usuario
 * nuestro. La autenticación es la firma HMAC sobre el cuerpo, que verifica
 * `IngestionService` contra el secreto cifrado de la conexión.
 *
 * Este handler hace lo MÍNIMO: resolver conexión, verificar firma, escribir el
 * payload crudo y responder. Cada cosa que se añada aquí es tiempo entre el
 * envío del proveedor y el ack, y pasado su timeout el proveedor reintenta —
 * que es exactamente como se generan los duplicados que luego hay que
 * deduplicar. El presupuesto declarado es 250 ms.
 */
@Controller({ path: 'integrations', version: '1' })
export class WebhookController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('webhooks/:token')
  @HttpCode(202)
  async receive(
    @Param('token') token: string,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<AckResult & { status: 'accepted' }> {
    // El cuerpo CRUDO es obligatorio: sin él no se puede validar un HMAC.
    // Si falta, es que la app se montó sin el parser `raw` de `configureApp` —
    // un fallo de configuración que debe verse de inmediato y no degradarse a
    // "firma mala", que enviaría a depurar el secreto equivocado.
    const crudo =
      req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : undefined);
    if (!crudo) {
      throw new ValidationError(
        'No se recibió el cuerpo crudo de la petición; no se puede verificar la firma.',
      );
    }

    const headers: WebhookHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }

    const ack = await this.ingestion.receiveWebhook(
      token,
      crudo.toString('utf8'),
      headers,
    );
    // 202 y no 201: aún no hay pedido, hay un compromiso de que lo habrá.
    return { ...ack, status: 'accepted' };
  }
}
