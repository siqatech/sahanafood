import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { OnboardingService } from './app/onboarding.service.js';
import { OnboardingController } from './api/onboarding.controller.js';

/**
 * Puesta en marcha (docs/26).
 *
 * No depende de ningún otro módulo aunque lea sus tablas: lo único que hace es
 * preguntar «¿existe ya al menos uno?» con seis `EXISTS`. Importar seis módulos
 * para eso acoplaría el arranque entero a una tarjeta de la portada, y además
 * los crearía en círculo — casi todos acabarían dependiendo de este.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
