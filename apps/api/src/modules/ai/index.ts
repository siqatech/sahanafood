/** API pública del módulo AI (spec 19, ADR-0011). */
export { AiModule } from './ai.module.js';
export { AI_PROVIDER } from './ai.tokens.js';
export { AgentService, type AgentReply, type Resolution } from './app/agent.service.js';
export {
  AgentConfigService,
  type ConfigView,
  type AgentIdentity,
  type AgentLimits,
} from './app/agent-config.service.js';
export { KnowledgeService, type SourceChunk } from './app/knowledge.service.js';
export { EchoAiProvider } from './app/echo-provider.js';
export type {
  AiProvider,
  ChatRequest,
  ChatResponse,
  ToolSpec,
  ToolCall,
} from './domain/ai-provider.js';
