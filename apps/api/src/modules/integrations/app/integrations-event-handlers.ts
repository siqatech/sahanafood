import { Injectable } from '@nestjs/common';
import { ChannelSyncService } from './channel-sync.service.js';
import type { DomainEventHandler } from '../../kitchen/index.js';

/**
 * Salida hacia los canales, disparada por eventos (spec 13, ADR-0007).
 *
 * Es el consumidor que faltaba para que `ChannelConnector` tuviera sus dos
 * mitades vivas. Sin él, `catalog.availability_changed` se publicaba y no lo
 * escuchaba nadie: la pausa de un producto agotado nunca salía del sistema.
 */
export const INTEGRATIONS_CONSUMER = 'integrations';

/** Estados del pedido que el canal necesita conocer. */
const ESTADOS_A_PROPAGAR = [
  'accepted',
  'preparing',
  'ready',
  'packed',
  'dispatched',
  'delivered',
  'picked_up',
  'rejected',
  'cancelled',
] as const;

@Injectable()
export class IntegrationsEventHandlers {
  constructor(private readonly sync: ChannelSyncService) {}

  handlers(): Record<string, DomainEventHandler> {
    const estado =
      (nombre: string): DomainEventHandler =>
      async (ctx, event) => {
        await this.sync.propagarEstado(ctx, {
          orderId: event.aggregateId,
          status: nombre,
        });
      };

    const porEstado: Record<string, DomainEventHandler> = {};
    for (const nombre of ESTADOS_A_PROPAGAR) {
      porEstado[`order.${nombre}`] = estado(nombre);
    }

    return {
      ...porEstado,

      'catalog.availability_changed': async (ctx, event) => {
        const productId = event.payload['productId'];
        const channels = event.payload['channels'];
        const paused = event.payload['paused'];
        if (typeof productId !== 'string' || !Array.isArray(channels)) return;
        await this.sync.propagarDisponibilidad(ctx, {
          productId,
          channels: channels.filter((c): c is string => typeof c === 'string'),
          // `paused: true` significa NO disponible. Se invierte aquí y no en el
          // conector para que cada conector nuevo no tenga que acordarse.
          available: paused !== true,
        });
      },

      'catalog.published': async (ctx, event) => {
        const brandId = event.payload['brandId'];
        const channel = event.payload['channel'];
        const version = event.payload['version'];
        if (
          typeof brandId !== 'string' ||
          typeof channel !== 'string' ||
          typeof version !== 'number'
        ) {
          return;
        }
        await this.sync.propagarMenu(ctx, { brandId, channel, version });
      },
    };
  }
}
