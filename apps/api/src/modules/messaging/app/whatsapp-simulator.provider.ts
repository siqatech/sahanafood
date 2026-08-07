import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  WhatsAppProvider,
  OutboundMessage,
  SendResult,
} from '../domain/whatsapp-provider.js';

/**
 * Simulador de WhatsApp (spec 12, T4.28).
 *
 * DP-04 —BSP o Cloud API directa— sigue abierto, y CLAUDE.md prohíbe integrar
 * proveedores reales en el MVP. Además, la verificación de Meta Business tarda
 * semanas: esperar a tenerla para escribir el módulo sería dejar el aviso al
 * cliente sin probar hasta el final de la fase.
 *
 * Reproduce lo que de verdad falla:
 *
 * · **Plantillas no aprobadas.** El fallo más común y el más lento de
 *   diagnosticar: Meta acepta la llamada y no entrega nada.
 * · **Números que no existen en WhatsApp.** Un teléfono válido no implica una
 *   cuenta; el cliente dejó su fijo, o un móvil sin la app.
 * · **Caídas.** Se puede tirar a voluntad para comprobar lo único que importa
 *   de verdad: que el PEDIDO SIGUE aunque el aviso no salga.
 *
 * Es determinista: el mismo mensaje da el mismo id. Un simulador aleatorio
 * produce pruebas que fallan una vez de cada veinte y acaban desactivadas.
 */

export interface WhatsAppSimulatorOptions {
  down?: boolean;
  /** Plantillas aprobadas. Cualquier otra se rechaza, como haría Meta. */
  approvedTemplates?: readonly string[];
  /** Números sin cuenta de WhatsApp. */
  unreachableNumbers?: readonly string[];
}

export const WA_REJECTION_CODES = {
  TEMPLATE_NOT_APPROVED: '132001',
  RECIPIENT_NOT_ON_WHATSAPP: '131026',
  OUTSIDE_WINDOW: '131047',
} as const;

/** Las plantillas del MVP: una por estado notificable (spec 12 §Alcance). */
const PLANTILLAS_POR_DEFECTO = [
  'pedido_confirmado',
  'pedido_en_preparacion',
  'pedido_en_camino',
  'pedido_entregado',
  'pedido_rechazado',
  'pedido_cancelado',
];

@Injectable()
export class WhatsAppSimulatorProvider implements WhatsAppProvider {
  readonly name = 'whatsapp-simulator';

  /** Lo enviado, para que las pruebas puedan mirar QUÉ se mandó. */
  readonly sent: OutboundMessage[] = [];

  /**
   * Sin parámetros en el constructor a propósito: Nest inyecta por tipo, y un
   * objeto de opciones en la firma le hace buscar un proveedor que no existe.
   * Se ajusta con `configure()`, que es lo que hacen las pruebas.
   */
  private options: Required<WhatsAppSimulatorOptions> = {
    down: false,
    approvedTemplates: PLANTILLAS_POR_DEFECTO,
    unreachableNumbers: [],
  };

  configure(options: WhatsAppSimulatorOptions): void {
    this.options = { ...this.options, ...options };
  }

  reset(): void {
    this.sent.length = 0;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.options.down) {
      return {
        kind: 'error',
        message: 'WhatsApp no responde (simulado).',
        retryable: true,
      };
    }

    if (this.options.unreachableNumbers.includes(message.to)) {
      // Un teléfono válido no implica una cuenta de WhatsApp: el cliente dejó
      // su fijo, o un móvil sin la app.
      return {
        kind: 'rejected',
        code: WA_REJECTION_CODES.RECIPIENT_NOT_ON_WHATSAPP,
        message: `${message.to} no tiene cuenta de WhatsApp.`,
      };
    }

    if (message.kind === 'template') {
      if (!message.templateName) {
        return {
          kind: 'rejected',
          code: WA_REJECTION_CODES.TEMPLATE_NOT_APPROVED,
          message: 'Falta el nombre de la plantilla.',
        };
      }
      if (!this.options.approvedTemplates.includes(message.templateName)) {
        // El fallo más común y el más lento de diagnosticar: Meta acepta la
        // llamada y no entrega nada.
        return {
          kind: 'rejected',
          code: WA_REJECTION_CODES.TEMPLATE_NOT_APPROVED,
          message: `La plantilla "${message.templateName}" no está aprobada.`,
        };
      }
    }

    this.sent.push(message);
    return {
      kind: 'sent',
      providerMessageId: `wamid.${createHash('sha256')
        .update(
          `${message.to}|${message.templateName ?? message.body ?? ''}|${this.sent.length}`,
        )
        .digest('hex')
        .slice(0, 20)}`,
    };
  }
}
