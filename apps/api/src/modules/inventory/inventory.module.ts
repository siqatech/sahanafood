import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { InventoryService } from './app/inventory.service.js';
import { InventoryAdminService } from './app/inventory-admin.service.js';
import { InventoryEventHandlers } from './app/inventory-event-handlers.js';
import { InventoryController } from './api/inventory.controller.js';

/**
 * Inventario (spec 08 parcial, T4.25).
 *
 * No depende de Ordering ni de Kitchen: reacciona a sus EVENTOS. Es lo que
 * permite que descontar inventario no pueda romper la aceptación de un pedido
 * — y RN-INV-02 exige justamente eso: jamás bloquear una venta por stock.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryEventHandlers, InventoryAdminService],
  exports: [InventoryService, InventoryEventHandlers, InventoryAdminService],
})
export class InventoryModule {}
