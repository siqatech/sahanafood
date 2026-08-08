import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { CatalogModule } from '../catalog/index.js';
import { OrganizationModule } from '../organization/index.js';
import { ConversationsModule } from '../conversations/index.js';
import { AI_PROVIDER } from './ai.tokens.js';
import { EchoAiProvider } from './app/echo-provider.js';
import { AgentService } from './app/agent.service.js';
import { AgentToolsService } from './app/agent-tools.service.js';
import { AgentConfigService } from './app/agent-config.service.js';
import { KnowledgeService } from './app/knowledge.service.js';
import { AgentAnalyticsService } from './app/agent-analytics.service.js';
import { AiEventHandlers } from './app/ai-event-handlers.js';
import { AiController } from './api/ai.controller.js';

/**
 * Plataforma de IA (spec 19, ADR-0011).
 *
 * **Apagar la IA deja el sistema 100 % funcional**: este módulo depende de
 * Catalog, Organization y Conversations, y NINGUNO depende de él. Quitarlo del
 * `AppModule` deja un sistema que vende, cobra, cocina y reparte igual.
 *
 * El proveedor se inyecta por token (ADR-0011 §3): cambiar de vendor es cambiar
 * este `useClass`. Por defecto va el determinista local, que es el que permite
 * correr la suite dorada en CI sin red ni clave de terceros.
 */
@Module({
  imports: [
    DatabaseModule,
    CatalogModule,
    OrganizationModule,
    ConversationsModule,
  ],
  controllers: [AiController],
  providers: [
    { provide: AI_PROVIDER, useClass: EchoAiProvider },
    AgentService,
    AgentToolsService,
    AgentConfigService,
    KnowledgeService,
    AgentAnalyticsService,
    AiEventHandlers,
  ],
  exports: [
    AgentService,
    AgentConfigService,
    KnowledgeService,
    AgentAnalyticsService,
    AiEventHandlers,
  ],
})
export class AiModule {}
