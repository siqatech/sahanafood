import { Module } from '@nestjs/common';
import { OrderingService } from './app/ordering.service.js';
import { OrderingController } from './api/ordering.controller.js';
import { CatalogModule } from '../catalog/index.js';
import { OrganizationModule } from '../organization/index.js';

/**
 * Módulo Ordering (spec 05). Depende de Catalog (precios) y Organization
 * (cobertura), ambos por su API pública.
 */
@Module({
  imports: [CatalogModule, OrganizationModule],
  controllers: [OrderingController],
  providers: [OrderingService],
  exports: [OrderingService],
})
export class OrderingModule {}
