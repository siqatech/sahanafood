import { Module } from '@nestjs/common';
import { AuditController } from './api/audit.controller.js';
import { AuditQueryService } from './app/audit-query.service.js';

@Module({
  controllers: [AuditController],
  providers: [AuditQueryService],
  exports: [AuditQueryService],
})
export class AuditModule {}
