import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { DeliveryModule } from '../delivery/index.js';
import { MessagingService } from './app/messaging.service.js';
import { MessagingEventHandlers } from './app/messaging-event-handlers.js';
import { WhatsAppSimulatorProvider } from './app/whatsapp-simulator.provider.js';
import { MessagingController } from './api/messaging.controller.js';
import { WHATSAPP_PROVIDER } from './messaging.tokens.js';

/**
 * Mensajería por WhatsApp (spec 12).
 *
 * El proveedor va por token: DP-04 —BSP o Cloud API directa— sigue abierto, y
 * la verificación de Meta Business tarda semanas. Esperar a tenerla para
 * escribir el módulo dejaría el aviso al cliente sin probar hasta el final de
 * la fase.
 */
@Module({
  imports: [DatabaseModule, DeliveryModule],
  controllers: [MessagingController],
  providers: [
    MessagingService,
    MessagingEventHandlers,
    WhatsAppSimulatorProvider,
    { provide: WHATSAPP_PROVIDER, useExisting: WhatsAppSimulatorProvider },
  ],
  exports: [
    MessagingService,
    MessagingEventHandlers,
    WhatsAppSimulatorProvider,
  ],
})
export class MessagingModule {}
