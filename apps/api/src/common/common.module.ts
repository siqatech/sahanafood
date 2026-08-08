import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PublicTokensService } from './public-tokens.service.js';

/**
 * Primitivas transversales que no son de ningún módulo de negocio.
 *
 * Hoy solo `PublicTokensService` (ADR-0017), y está aquí por una razón de
 * fronteras, no de comodidad: los links de pago los emite `payments` y el
 * tracking público lo emitirá `delivery`. Si el servicio viviera dentro de
 * `payments`, delivery tendría que importar internals de pagos para algo que no
 * tiene nada que ver con cobrar — y `dependency-cruiser` lo rompería con razón.
 *
 * `@Global` porque el mecanismo es infraestructura, como el pool: cualquier
 * módulo que emita un enlace público lo necesita, y obligar a cada uno a
 * importarlo solo añade ruido a la lista de imports.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [PublicTokensService],
  exports: [PublicTokensService],
})
export class CommonModule {}
