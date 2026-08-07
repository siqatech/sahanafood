import type { PrintQueue } from './print-queue.js';
import type { PrinterTransport } from '../transport/printer.js';

/**
 * Despachador: saca trabajos de la cola y los manda a su impresora.
 *
 * Va de UNO EN UNO a propósito. Una térmica no admite dos trabajos
 * simultáneos: si se le mandan a la vez, los bytes se intercalan y salen dos
 * tickets mezclados en el mismo papel, que es peor que no imprimir ninguno.
 *
 * Y «de uno en uno» tiene que valer también entre llamadas: al agente le
 * entran dos disparos a la vez —el bucle de reintentos cada 5 s y el que
 * provoca cada petición de la PWA—. `nextPending()` es síncrono, así que dos
 * `drain()` solapados eligen el MISMO trabajo antes de que ninguno llegue a
 * marcarlo, y sale la comanda por duplicado. Por eso se encadenan.
 */
export interface DispatchResult {
  processed: number;
  printed: number;
  failed: number;
}

export class PrintDispatcher {
  /** Cola de turnos: garantiza que solo haya un `drain` vivo a la vez. */
  private cadena: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly queue: PrintQueue,
    private readonly printers: Map<string, PrinterTransport>,
  ) {}

  /**
   * Procesa hasta `limit` trabajos. Devuelve el desglose para que el bucle del
   * agente sepa si merece la pena volver enseguida o esperar.
   *
   * Si ya hay un despacho en curso, este espera su turno en vez de solaparse.
   */
  drain(limit = 20, now = Date.now()): Promise<DispatchResult> {
    const turno = this.cadena.then(() => this.despachar(limit, now));
    // La cadena traga el error: el fallo lo recibe quien llamó, pero no debe
    // envenenar el turno del siguiente.
    this.cadena = turno.catch(() => undefined);
    return turno;
  }

  /**
   * Espera a que termine lo que haya en curso. Lo usa el apagado limpio: matar
   * el proceso a mitad de un envío deja media comanda en el papel.
   */
  async idle(): Promise<void> {
    await this.cadena;
  }

  private async despachar(limit: number, now: number): Promise<DispatchResult> {
    const resultado: DispatchResult = { processed: 0, printed: 0, failed: 0 };

    for (let i = 0; i < limit; i++) {
      const job = this.queue.nextPending(now);
      if (!job) break;

      resultado.processed++;
      await this.queue.markPrinting(job.id);

      const impresora = this.printers.get(job.printer);
      if (!impresora) {
        // Configuración incompleta, no fallo transitorio. Se registra igual y
        // se reintenta: la impresora puede aparecer cuando alguien la añada.
        await this.queue.markFailed(
          job.id,
          `No hay ninguna impresora configurada con el nombre "${job.printer}".`,
          now,
        );
        resultado.failed++;
        continue;
      }

      try {
        await impresora.send(Buffer.from(job.payloadBase64, 'base64'));
        await this.queue.markDone(job.id, now);
        resultado.printed++;
      } catch (error) {
        await this.queue.markFailed(
          job.id,
          error instanceof Error ? error.message : String(error),
          now,
        );
        resultado.failed++;
      }
    }

    return resultado;
  }

  /** Salud de cada impresora, para el panel y para avisar a la nube. */
  async health(): Promise<
    Array<{ printer: string; reachable: boolean; pendingJobs: number }>
  > {
    const trabajos = this.queue.all();
    const salida: Array<{
      printer: string;
      reachable: boolean;
      pendingJobs: number;
    }> = [];

    for (const [nombre, transporte] of this.printers) {
      salida.push({
        printer: nombre,
        reachable: await transporte.probe(),
        pendingJobs: trabajos.filter(
          (j) =>
            j.printer === nombre &&
            (j.status === 'pending' || j.status === 'printing'),
        ).length,
      });
    }
    return salida;
  }
}
