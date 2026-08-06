import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './config.js';

/** Provee la configuración tipada y validada como inyectable global. */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG],
})
export class ConfigModule {}
