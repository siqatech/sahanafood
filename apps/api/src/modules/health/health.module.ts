import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { HealthController } from './health.controller.js';

/**
 * Salud del proceso. Importa `DatabaseModule` porque la sonda de readiness
 * (T5.35) comprueba de verdad que la base responde y que el esquema alcanza a
 * lo que esta imagen necesita: una sonda que solo dice «el proceso arrancó»
 * mantiene en el balanceador a una instancia que no puede servir ni una
 * consulta.
 */
@Module({ imports: [DatabaseModule], controllers: [HealthController] })
export class HealthModule {}
