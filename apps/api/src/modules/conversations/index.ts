/** API pública del módulo Conversations (spec 18). */
export { ConversationsModule } from './conversations.module.js';
export {
  ConversationsService,
  WindowExpiredError,
  type ConversationView,
  type MessageView,
  type HandoffSummary,
  type QuickReplyView,
} from './app/conversations.service.js';
