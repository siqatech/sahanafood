/** API pública del módulo Messaging (spec 12). */
export { MessagingModule } from './messaging.module.js';
export { WHATSAPP_PROVIDER } from './messaging.tokens.js';
export {
  MessagingService,
  type NotifyResult,
  type OrderMessageStats,
} from './app/messaging.service.js';
export {
  MessagingEventHandlers,
  MESSAGING_CONSUMER,
} from './app/messaging-event-handlers.js';
export {
  WhatsAppSimulatorProvider,
  WA_REJECTION_CODES,
  type WhatsAppSimulatorOptions,
} from './app/whatsapp-simulator.provider.js';
export type {
  WhatsAppProvider,
  OutboundMessage,
  InboundMessage,
  SendResult,
} from './domain/whatsapp-provider.js';
