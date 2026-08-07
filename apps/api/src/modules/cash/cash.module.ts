import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/index.js';
import { CashService } from './app/cash.service.js';
import { CashController } from './api/cash.controller.js';

/**
 * Caja (spec 06). Depende de Identity para el PIN de supervisor que autoriza
 * un cierre descuadrado (RN-POS-02): reutiliza el bloqueo por intentos de F3
 * en vez de inventar otra verificación.
 */
@Module({
  imports: [IdentityModule],
  controllers: [CashController],
  providers: [CashService],
  exports: [CashService],
})
export class CashModule {}
