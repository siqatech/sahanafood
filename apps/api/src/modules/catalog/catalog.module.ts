import { Module } from '@nestjs/common';
import { CatalogService } from './app/catalog.service.js';
import { CatalogPublicationService } from './app/catalog-publication.service.js';
import { CatalogAdminService } from './app/catalog-admin.service.js';
import {
  CatalogAdminController,
  CatalogController,
} from './api/catalog.controller.js';

@Module({
  controllers: [CatalogController, CatalogAdminController],
  providers: [CatalogService, CatalogPublicationService, CatalogAdminService],
  exports: [CatalogService, CatalogPublicationService, CatalogAdminService],
})
export class CatalogModule {}
