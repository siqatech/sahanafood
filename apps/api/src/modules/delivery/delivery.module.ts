import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { CashModule } from '../cash/index.js';
import { DeliveryService } from './app/delivery.service.js';
import {
  DeliveryController,
  TrackingController,
} from './api/delivery.controller.js';

/**
 * Delivery propio (spec 09, F5).
 *
 * Depende de Caja porque la liquidación del cobro contra entrega termina en una
 * sesión de caja (RN-DLV-02), y NO al revés: la caja no sabe que existen los
 * repartidores. Esa dirección es la que permite que un negocio sin reparto
 * propio —solo marketplace o solo mostrador— no arrastre nada de este módulo.
 */
@Module({
  imports: [DatabaseModule, CashModule],
  controllers: [DeliveryController, TrackingController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
