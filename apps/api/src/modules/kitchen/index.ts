/**
 * API pública del módulo Kitchen (spec 07).
 *
 * `KitchenEventHandlers` es lo que el worker monta para que cocina se entere de
 * los pedidos: sin ese consumidor, `order.accepted` sería un evento que nadie
 * escucha.
 */
export { KitchenModule } from './kitchen.module.js';
export {
  KitchenService,
  TicketInvalidTransitionError,
  PackChecklistIncompleteError,
  OrderNotReadyError,
  type TicketView,
  type TicketLine,
  type TicketStatus,
  type CreateTicketsResult,
} from './app/kitchen.service.js';
export {
  KitchenEventHandlers,
  KITCHEN_CONSUMER,
  type DomainEventHandler,
  type DomainEventMessage,
} from './app/kitchen-event-handlers.js';
export {
  SaturationService,
  type CapacityConfig,
  type SaturationResult,
} from './app/saturation.service.js';
