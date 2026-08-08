import { Module } from '@nestjs/common';
import { OrganizationService } from './app/organization.service.js';
import {
  OrganizationController,
  OrganizationAdminController,
} from './api/organization.controller.js';
import { OrganizationAdminService } from './app/organization-admin.service.js';

@Module({
  controllers: [OrganizationController, OrganizationAdminController],
  providers: [OrganizationService, OrganizationAdminService],
  exports: [OrganizationService, OrganizationAdminService],
})
export class OrganizationModule {}
