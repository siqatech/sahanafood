import { Logger } from '@nestjs/common';
import {
  workerRunDuration,
  workerRunErrors,
  workerRunsTotal,
} from '../observability/metrics.js';
import { withSpan } from '../observability/tracing.js';

/**
 * Trabajo periódico del worker.
 *
 * Es una pieza pequeña con cuatro propiedades que, si faltan, se pagan en
 * producción y no en las pruebas:
 *
 * 1. **Sin solapamiento.** Si una vuelta tarda más que el intervalo, no se
 *    lanza otra encima. Sin esta guarda, un barrido lento acumula ejecuciones
 *    concurrentes, cada una consumiendo conexiones del pool, hasta que ninguna
 *    termina. Es la forma más habitual de tumbar un worker por su propio éxito.
 * 2. **Tolerante a fallos.** Un error en una vuelta se registra y la siguiente
 *    ocurre igual. Un worker que muere al primer fallo transitorio de red deja
 *    de publicar eventos y nadie se entera hasta que la cocina pregunta.
 * 3. **Apagado limpio.** `stop()` espera a que termine la vuelta en curso. En un
 *    despliegue, matar el proceso a mitad de una transición dejaría el trabajo
 *    a medias — recuperable, pero ruidoso y evitable.
 * 4. **Observable.** Cada vuelta deja duración, resultado y traza. Un proceso de
 *    fondo sin métricas es un proceso del que solo se sabe que está caído
 *    cuando ya hizo daño.
 */

export interface PeriodicJobOptions {
  name: string;
  intervalMs: number;
  /** Espera antes de la primera vuelta; evita que todo arranque a la vez. */
  initialDelayMs?: number;
  run: () => Promise<void>;
  /** Inyectable en pruebas para no depender del reloj real. */
  sleep?: (ms: number) => Promise<void>;
}

const dormir = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PeriodicJob {
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private corriendo = false;
  private detenido = false;
  /** Vuelta en curso; `stop()` la espera antes de dar por cerrado el job. */
  private enVuelo: Promise<void> = Promise.resolve();
  private bucle: Promise<void> | undefined;

  constructor(private readonly options: PeriodicJobOptions) {
    this.logger = new Logger(`Job:${options.name}`);
    this.sleep = options.sleep ?? dormir;
  }

  /** Arranca el bucle. No espera: devuelve en cuanto queda programado. */
  start(): void {
    if (this.bucle) return;
    this.bucle = this.correrBucle();
  }

  private async correrBucle(): Promise<void> {
    if (this.options.initialDelayMs) {
      await this.sleep(this.options.initialDelayMs);
    }
    while (!this.detenido) {
      this.enVuelo = this.unaVuelta();
      await this.enVuelo;
      if (this.detenido) break;
      await this.sleep(this.options.intervalMs);
    }
  }

  /**
   * Ejecuta una vuelta. Público para que las pruebas puedan forzarla sin
   * depender de temporizadores, y para poder dispararla a mano en un incidente.
   */
  async runOnce(): Promise<void> {
    return this.unaVuelta();
  }

  private async unaVuelta(): Promise<void> {
    if (this.corriendo) {
      // La vuelta anterior sigue viva: se salta esta en vez de encimarla.
      this.logger.warn(
        `La vuelta anterior sigue en curso; se omite esta (intervalo ${this.options.intervalMs} ms demasiado corto para el trabajo real).`,
      );
      return;
    }
    this.corriendo = true;
    const inicio = process.hrtime.bigint();
    try {
      await withSpan(
        `worker.${this.options.name}`,
        { 'sahana.job.name': this.options.name },
        () => this.options.run(),
      );
      workerRunsTotal.inc({ job: this.options.name, result: 'ok' });
    } catch (error) {
      workerRunsTotal.inc({ job: this.options.name, result: 'error' });
      workerRunErrors.inc({ job: this.options.name });
      this.logger.error(
        `Vuelta fallida: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      workerRunDuration.observe(
        { job: this.options.name },
        Number(process.hrtime.bigint() - inicio) / 1e9,
      );
      this.corriendo = false;
    }
  }

  /** Detiene el bucle y espera a que la vuelta en curso termine. */
  async stop(): Promise<void> {
    this.detenido = true;
    await this.enVuelo.catch(() => undefined);
  }

  get isRunning(): boolean {
    return this.corriendo;
  }
}
