import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module.js';

/**
 * Sondas de salud (docs/17, T5.35).
 *
 * `/health` es **liveness**: ¿el proceso responde? Si esto falla, hay que
 * reiniciar la instancia.
 *
 * `/health/ready` es **readiness**: ¿esta instancia puede atender tráfico? Es
 * la que gobierna un despliegue canario — el balanceador manda el 10 % del
 * tráfico a la versión nueva solo mientras diga que sí, y deja de mandárselo en
 * cuanto diga que no. Separarlas importa: un proceso vivo pero con la base
 * caída tiene que salir del balanceador **sin** que nadie lo reinicie, porque
 * reiniciarlo no arregla la base y sí tira las peticiones en vuelo.
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../infra/migrations',
);

export interface ReadinessView {
  status: 'ready' | 'not_ready';
  /** Última migración aplicada en la base. */
  schemaApplied: string | null;
  /** Última migración que trae ESTA imagen. */
  schemaRequired: string | null;
  /**
   * La base va por delante del código. **No impide servir**: es el estado
   * normal justo después de revertir a la imagen anterior.
   */
  schemaAhead: boolean;
  database: 'ok' | 'down';
  version: string;
  traceId: string | undefined;
}

@Controller({ path: 'health', version: '1' })
export class HealthController {
  private readonly startedAt = Date.now();
  /** Se lee una vez: el contenido de la imagen no cambia en caliente. */
  private requerida: string | null | undefined;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  health(@Req() req: Request & { traceId?: string }): {
    status: 'ok';
    traceId: string | undefined;
    uptimeSeconds: number;
    version: string;
  } {
    return {
      status: 'ok',
      traceId: req.traceId,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }

  /**
   * ¿Puede esta instancia atender tráfico?
   *
   * La condición que hace posible el rollback: **una base POR DELANTE del
   * código está lista**. Volver a la imagen anterior deja exactamente esa
   * situación —el esquema tiene migraciones que el código viejo no conoce— y si
   * la sonda la marcara como no lista, revertir exigiría tocar la base, que es
   * justo lo que el criterio de la fase prohíbe. Al revés no: código que
   * necesita una migración que no está aplicada **no** puede servir, porque sus
   * consultas fallarían una a una contra columnas que no existen.
   *
   * Esto solo se sostiene si las migraciones son compatibles hacia atrás, y de
   * eso se encarga el gate `infra/scripts/check-migrations.mjs`. Las dos piezas
   * son la misma garantía: sin el gate, esta sonda mentiría.
   */
  @Get('ready')
  async ready(
    @Req() req: Request & { traceId?: string },
  ): Promise<ReadinessView> {
    const requerida = await this.migracionRequerida();
    let aplicada: string | null = null;
    let database: 'ok' | 'down' = 'ok';

    try {
      const { rows } = await this.pool.query<{ name: string }>(
        'SELECT name FROM _migrations ORDER BY name DESC LIMIT 1',
      );
      aplicada = rows[0]?.name ?? null;
    } catch {
      database = 'down';
    }

    const alDia =
      database === 'ok' &&
      (requerida === null || (aplicada !== null && aplicada >= requerida));

    return {
      status: alDia ? 'ready' : 'not_ready',
      schemaApplied: aplicada,
      schemaRequired: requerida,
      schemaAhead:
        aplicada !== null && requerida !== null && aplicada > requerida,
      database,
      version: process.env.npm_package_version ?? '0.1.0',
      traceId: req.traceId,
    };
  }

  /**
   * La última migración que trae la imagen.
   *
   * Se lee del disco y no de una constante en el código a propósito: una
   * constante hay que acordarse de subirla, y el día que se olvide la sonda
   * diría «listo» con el esquema a medias. El directorio viaja con la imagen,
   * así que una imagen antigua trae su lista antigua — que es exactamente lo
   * que hace que el rollback se dé por listo.
   */
  private async migracionRequerida(): Promise<string | null> {
    if (this.requerida !== undefined) return this.requerida;
    try {
      const archivos = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      this.requerida = archivos[archivos.length - 1] ?? null;
    } catch {
      // Sin directorio de migraciones no se puede afirmar nada del esquema, y
      // afirmar «no listo» dejaría la instancia fuera del balanceador por algo
      // que no es un problema de la instancia.
      this.requerida = null;
    }
    return this.requerida;
  }
}
