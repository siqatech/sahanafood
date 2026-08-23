import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { CrmService } from './app/crm.service.js';
import { CrmController } from './api/crm.controller.js';

/**
 * Clientes (spec 14: perfil e historial en F5, campañas en F8).
 *
 * Sin dependencias de otros módulos: el cliente se DERIVA de los pedidos con
 * una consulta agregada, así que no hace falta pedirle nada a Ordering. Y sin
 * tabla propia, así que tampoco hay migración.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [CrmController],
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmModule {}
