import { Module } from '@nestjs/common';
import { OrganizationService } from './app/organization.service.js';
import { OrganizationController } from './api/organization.controller.js';

@Module({
  controllers: [OrganizationController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
