import { Module } from '@nestjs/common';
import { CatalogService } from './app/catalog.service.js';
import { CatalogPublicationService } from './app/catalog-publication.service.js';
import { CatalogController } from './api/catalog.controller.js';

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, CatalogPublicationService],
  exports: [CatalogService, CatalogPublicationService],
})
export class CatalogModule {}
