import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './app/auth.service.js';
import { DeviceService } from './app/device.service.js';
import { AuthController } from './api/auth.controller.js';
import { DeviceController } from './api/device.controller.js';
import { RequirePermissionGuard } from './api/require-permission.guard.js';

/**
 * Módulo Identity (spec 02). Registra el guard de permisos como guard GLOBAL:
 * así, cualquier endpoint de cualquier módulo que declare @RequirePermission
 * queda protegido sin configuración adicional, y los que no lo declaran siguen
 * siendo públicos de forma explícita.
 */
@Module({
  controllers: [AuthController, DeviceController],
  providers: [
    AuthService,
    DeviceService,
    { provide: APP_GUARD, useClass: RequirePermissionGuard },
  ],
  exports: [AuthService, DeviceService],
})
export class IdentityModule {}
