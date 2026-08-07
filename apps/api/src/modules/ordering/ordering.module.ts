import { Module } from '@nestjs/common';
import { OrderingService } from './app/ordering.service.js';
import { AcceptanceService } from './app/acceptance.service.js';
import { OrderingController } from './api/ordering.controller.js';
import { AcceptanceController } from './api/acceptance.controller.js';
import { CatalogModule } from '../catalog/index.js';
import { OrganizationModule } from '../organization/index.js';
import { IdentityModule } from '../identity/index.js';

/**
 * Módulo Ordering (spec 05). Depende de Catalog (precios) y Organization
 * (cobertura), ambos por su API pública.
 */
@Module({
  imports: [CatalogModule, OrganizationModule, IdentityModule],
  controllers: [OrderingController, AcceptanceController],
  providers: [OrderingService, AcceptanceService],
  exports: [OrderingService, AcceptanceService],
})
export class OrderingModule {}
