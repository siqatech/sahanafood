/** API pública del módulo Conversations (spec 18). */
export { ConversationsModule } from './conversations.module.js';
export {
  ConversationsService,
  WindowExpiredError,
  type ConversationView,
  type MessageView,
  type HandoffSummary,
} from './app/conversations.service.js';
