import { Module } from '@nestjs/common';
import { TenancyService } from './app/tenancy.service.js';
import { TenantController } from './api/tenant.controller.js';

@Module({
  controllers: [TenantController],
  providers: [TenancyService],
  exports: [TenancyService],
})
export class TenancyModule {}
