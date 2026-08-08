import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { OrderingModule } from '../ordering/index.js';
import { PaymentsService } from './app/payments.service.js';
import { CulqiSandboxProvider } from './app/providers/culqi-sandbox.provider.js';
import { MercadoPagoSandboxProvider } from './app/providers/mercadopago-sandbox.provider.js';
import {
  PaymentsController,
  PaymentWebhookController,
} from './api/payments.controller.js';
import { PAYMENT_PROVIDERS } from './payments.tokens.js';

/**
 * Pagos online (spec 10 parte F5, ADR-0016).
 *
 * Las pasarelas se inyectan como LISTA: la spec pide dos como mínimo por
 * adaptador, y un tenant puede cobrar con una mientras otro cobra con otra.
 * DP-03 —qué pasarelas se contratan— sigue abierto, así que ambas son sandbox.
 *
 * Se eligieron dos que se parecen lo menos posible dentro de lo verosímil
 * (formato de firma, vocabulario de estados, y si el proveedor manda o no un
 * identificador de evento). Dos sandbox gemelos habrían demostrado solo que el
 * código compila dos veces; estos dos prueban que el puerto es de verdad un
 * anti-corruption layer.
 */
@Module({
  imports: [DatabaseModule, OrderingModule],
  controllers: [PaymentsController, PaymentWebhookController],
  providers: [
    PaymentsService,
    CulqiSandboxProvider,
    MercadoPagoSandboxProvider,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (
        culqi: CulqiSandboxProvider,
        mercadopago: MercadoPagoSandboxProvider,
      ) => [culqi, mercadopago],
      inject: [CulqiSandboxProvider, MercadoPagoSandboxProvider],
    },
  ],
  exports: [PaymentsService, CulqiSandboxProvider, MercadoPagoSandboxProvider],
})
export class PaymentsModule {}
