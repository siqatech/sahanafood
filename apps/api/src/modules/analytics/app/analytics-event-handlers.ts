import { Injectable } from '@nestjs/common';
import { AnalyticsService } from './analytics.service.js';
import type { DomainEventHandler } from '../../kitchen/index.js';

/**
 * Alimentación de la proyección desde los eventos (spec 16, ADR-0007).
 *
 * Comparten transacción con la marca de `inbox`, igual que cocina e
 * inventario: o la venta entra en la proyección y queda marcada, o no pasa
 * ninguna de las dos cosas. Un panel que se salta ventas es peor que un panel
 * vacío — el vacío se nota, el que falta el 3 % no.
 */
export const ANALYTICS_CONSUMER = 'analytics';

@Injectable()
export class AnalyticsEventHandlers {
  constructor(private readonly analytics: AnalyticsService) {}

  handlers(): Record<string, DomainEventHandler> {
    return {
      // La venta se cuenta al ACEPTAR, no al recibir: un pedido rechazado o
      // vencido no es una venta, y contarlo inflaría el ingreso durante los
      // diez minutos de la ventana de aceptación.
      'order.accepted': async (ctx, event) => {
        await this.analytics.recordSale(ctx, event.aggregateId);
        // El costo puede no estar listo todavía —el inventario se descuenta en
        // otro consumidor—; se intenta igual y si no hay, se recoge después.
        await this.analytics.recordCost(ctx, event.aggregateId);
      },

      // El costo llega cuando el inventario ya descontó. Es un evento aparte
      // porque esperar a tener las dos cosas dejaría el panel vacío durante el
      // servicio, que es cuando se mira.
      'inventory.stock_alert': async (ctx, event) => {
        const orderId = event.payload['orderId'];
        if (typeof orderId === 'string') {
          await this.analytics.recordCost(ctx, orderId);
        }
      },

      'order.cancelled': async (ctx, event) => {
        await this.analytics.recordCancellation(ctx, event.aggregateId);
      },
      'order.rejected': async (ctx, event) => {
        await this.analytics.recordCancellation(ctx, event.aggregateId);
      },
    };
  }
}
