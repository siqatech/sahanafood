import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { OrganizationModule } from '../organization/index.js';
import { OrderingModule } from '../ordering/index.js';
import { CatalogModule } from '../catalog/index.js';
import { StorefrontService } from './app/storefront.service.js';
import {
  StorefrontAdminController,
  ShopController,
} from './api/storefront.controller.js';

/**
 * Tienda web (spec 11, F5).
 *
 * Depende de Catalog (qué se vende y a qué precio), Organization (a dónde
 * llegamos) y Ordering (dónde acaba la compra). Ninguno depende de este: la
 * tienda es un CLIENTE del sistema, igual que el POS, y esa dirección de la
 * flecha es lo que permite que mañana haya otra tienda —una app, un quiosco—
 * sin tocar nada de lo de abajo.
 */
@Module({
  imports: [DatabaseModule, OrganizationModule, OrderingModule, CatalogModule],
  controllers: [StorefrontAdminController, ShopController],
  providers: [StorefrontService],
  exports: [StorefrontService],
})
export class StorefrontModule {}
