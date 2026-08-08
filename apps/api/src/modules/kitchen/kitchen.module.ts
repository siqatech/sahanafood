import { Module } from '@nestjs/common';
import { OrderingModule } from '../ordering/index.js';
import { OrganizationModule } from '../organization/index.js';
import { KitchenService } from './app/kitchen.service.js';
import { SaturationService } from './app/saturation.service.js';
import { KitchenEventHandlers } from './app/kitchen-event-handlers.js';
import { KitchenController } from './api/kitchen.controller.js';

/**
 * Cocina / KDS (spec 07).
 *
 * Depende de Ordering por su API pública: cocina no escribe en `ord_*`, pide
 * las transiciones al orquestador (RN-ORD-01).
 */
@Module({
  imports: [OrderingModule, OrganizationModule],
  controllers: [KitchenController],
  providers: [KitchenService, SaturationService, KitchenEventHandlers],
  exports: [KitchenService, SaturationService, KitchenEventHandlers],
})
export class KitchenModule {}
