import { Module } from '@nestjs/common';
import { OrderingModule } from '../ordering/index.js';
import { ConnectionService } from './app/connection.service.js';
import { IngestionService } from './app/ingestion.service.js';
import { WebhookController } from './api/webhook.controller.js';
import { IntegrationsController } from './api/integrations.controller.js';

/**
 * Plataforma de integraciones (spec 13).
 *
 * Depende de Ordering por su API pública: la ingesta NO escribe en `ord_*`,
 * llama a `OrderingService` como cualquier otro módulo (RN-ORD-01).
 */
@Module({
  imports: [OrderingModule],
  controllers: [WebhookController, IntegrationsController],
  providers: [ConnectionService, IngestionService],
  exports: [ConnectionService, IngestionService],
})
export class IntegrationsModule {}
