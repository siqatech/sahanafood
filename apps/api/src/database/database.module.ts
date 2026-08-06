import { Global, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { CONFIG, type AppConfig } from '../config/config.js';
import { createPool } from './pool.js';

/** Token de inyección del pool de Postgres (rol de app, sujeto a RLS). */
export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (config: AppConfig): Pool => createPool(config.databaseUrl),
      inject: [CONFIG],
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
