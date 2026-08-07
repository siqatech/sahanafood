import { Injectable, Logger } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import type {
  DomainEventHandler,
  DomainEventMessage,
} from '../../kitchen/index.js';

/**
 * Reacciones de Inventario a los eventos de dominio (ADR-0007).
 *
 * El consumo se dispara con `order.accepted` y no al crear el pedido: un
 * pedido rechazado o vencido no ha consumido nada, y descontar antes de
 * aceptar dejaría el inventario mintiendo durante los diez minutos de la
 * ventana de aceptación.
 *
 * El efecto se escribe en la MISMA transacción del consumidor que la marca de
 * `inbox`: o se descuenta el inventario y queda registrado como procesado, o
 * no pasa ninguna de las dos cosas. Sin eso, una entrega repetida de BullMQ
 * descontaría la despensa dos veces por el mismo pedido.
 */

/** Nombre del consumidor en la tabla `inbox`. Cambiarlo reprocesa todo. */
export const INVENTORY_CONSUMER = 'inventory';

@Injectable()
export class InventoryEventHandlers {
  private readonly logger = new Logger(InventoryEventHandlers.name);

  constructor(private readonly inventory: InventoryService) {}

  handlers(): Record<string, DomainEventHandler> {
    return {
      'order.accepted': async (ctx, event) => {
        const resumen = await this.inventory.consumeForOrder(
          event.tenantId,
          event.aggregateId,
          { ctx, ...(event.traceId ? { traceId: event.traceId } : {}) },
        );

        if (resumen.alreadyConsumed) {
          this.logger.debug(
            `El pedido ${event.aggregateId} ya había consumido inventario: entrega repetida.`,
          );
          return;
        }

        // Los avisos salen por outbox, en esta misma transacción. Publicarlos
        // fuera abriría la ventana en la que el inventario ya bajó y nadie se
        // ha enterado — y el aviso de «carne en negativo» solo sirve si llega
        // durante el servicio.
        await this.inventory.publishAlerts(
          ctx,
          event.aggregateId,
          resumen.alerts,
        );

        if (resumen.productsWithoutRecipe.length > 0) {
          this.logger.warn(
            `Pedido ${event.aggregateId}: ${resumen.productsWithoutRecipe.length} producto(s) vendidos sin receta; su costo no está calculado.`,
          );
        }
      },

      /**
       * Cancelación (RN-INV-03).
       *
       * Antes de preparar → reversa: la comida no se hizo, los insumos siguen
       * en la despensa. Después → merma con motivo: la carne ya se cocinó y se
       * tira, así que el stock NO vuelve, pero el costo queda atribuido para
       * que el margen de la marca no salga inflado.
       */
      'order.cancelled': async (ctx, event) => {
        const preparado = this.sePreparo(event);
        await this.inventory.reverseForOrder(
          event.tenantId,
          event.aggregateId,
          {
            ctx,
            prepared: preparado,
            reason: preparado
              ? `Pedido cancelado tras preparar: ${this.motivo(event)}`
              : `Pedido cancelado antes de preparar: ${this.motivo(event)}`,
            ...(event.traceId ? { traceId: event.traceId } : {}),
          },
        );
      },
    };
  }

  /**
   * ¿Se había empezado a cocinar?
   *
   * Se lee del estado que traía el pedido AL CANCELARSE, incluido en el evento.
   * Consultarlo ahora daría `cancelled` y no diría nada: para entonces el
   * pedido ya cambió de estado y el dato que decide entre reversa y merma se
   * habría perdido.
   */
  private sePreparo(event: DomainEventMessage): boolean {
    // `from` es el campo que emite Ordering en toda transición.
    const previo = event.payload['from'];
    return (
      typeof previo === 'string' &&
      ['preparing', 'ready', 'packed', 'dispatched'].includes(previo)
    );
  }

  private motivo(event: DomainEventMessage): string {
    const razon = event.payload['reason'];
    return typeof razon === 'string' && razon.trim() ? razon : 'sin motivo';
  }
}
