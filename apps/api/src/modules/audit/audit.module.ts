import { Module } from '@nestjs/common';
import { AuditController } from './api/audit.controller.js';

@Module({ controllers: [AuditController] })
export class AuditModule {}
