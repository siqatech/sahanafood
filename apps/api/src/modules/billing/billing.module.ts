import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { BillingService } from './app/billing.service.js';
import { OseSandboxProvider } from './app/ose-sandbox.provider.js';
import { BillingController } from './api/billing.controller.js';
import { BILLING_PROVIDER } from './billing.tokens.js';

/**
 * Facturación electrónica (spec 10, ADR-0003).
 *
 * El proveedor se inyecta por token: DP-02 —qué OSE se contrata— sigue
 * abierto, y CLAUDE.md prohíbe integrar proveedores reales en el MVP. Se corre
 * contra el sandbox simulado, que reproduce lo que de verdad cuesta —rechazos
 * con código, caídas y respuestas perdidas— y es reproducible por semilla.
 *
 * Cuando DP-02 se cierre, cambiar de proveedor es cambiar este `useClass`.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    OseSandboxProvider,
    { provide: BILLING_PROVIDER, useExisting: OseSandboxProvider },
  ],
  exports: [BillingService, OseSandboxProvider],
})
export class BillingModule {}
