import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { MessagingModule } from '../messaging/index.js';
import { OrderingModule } from '../ordering/index.js';
import { ConversationsService } from './app/conversations.service.js';
import {
  ConversationsController,
  QuickRepliesController,
} from './api/conversations.controller.js';

/**
 * Bandeja omnicanal (spec 18, F5).
 *
 * Depende de Messaging (el contacto y el proveedor de WhatsApp) y de Ordering
 * (crear un pedido pasa por su API, nunca por SQL). El agente de IA de T5.22+
 * dependerá de ESTE módulo, no al revés: el agente escribe en una conversación
 * que ya existe.
 */
@Module({
  imports: [DatabaseModule, MessagingModule, OrderingModule],
  controllers: [ConversationsController, QuickRepliesController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
