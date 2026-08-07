import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Cola de impresión del agente (ADR-0008).
 *
 * Existe porque una impresora térmica falla de formas que no son «error de
 * red»: se queda sin papel a media comanda, alguien la apaga para enchufar
 * otra cosa, la tapa queda mal cerrada. Sin cola, cada uno de esos casos es
 * una comanda que la cocina nunca vio y un pedido que nadie prepara.
 *
 * Tres decisiones que la hacen útil de verdad:
 *
 * 1. **Persiste en disco antes de intentar imprimir.** Si el agente se reinicia
 *    —o el local se queda sin luz, que es el motivo habitual— los trabajos
 *    pendientes siguen ahí. Un trabajo solo en memoria es un trabajo perdido.
 * 2. **Escritura atómica** (fichero temporal + rename). Un corte de luz durante
 *    el guardado dejaría el JSON a medias y la cola entera ilegible: se
 *    perderían TODOS los pendientes, no solo el que se estaba escribiendo.
 * 3. **Nada se borra al fallar.** Un trabajo agotado queda en `failed` y se
 *    puede reimprimir a mano. El operador prefiere reimprimir de más que
 *    descubrir que faltó una comanda.
 */

export type PrintJobStatus = 'pending' | 'printing' | 'done' | 'failed';

export interface PrintJob {
  readonly id: string;
  /** Impresora destino, por nombre lógico configurado en el agente. */
  readonly printer: string;
  /** Bytes ESC/POS ya generados, en base64 para poder serializarlos. */
  readonly payloadBase64: string;
  /** Qué es: `kitchen_ticket`, `precheck`... Solo para diagnóstico y reimpresión. */
  readonly kind: string;
  /** Referencia legible: número de pedido. El operador busca por esto. */
  readonly reference: string;
  status: PrintJobStatus;
  attempts: number;
  readonly createdAt: number;
  nextAttemptAt: number;
  lastError?: string | undefined;
  printedAt?: number | undefined;
}

export interface PrintQueueOptions {
  /** Fichero donde se persiste. */
  filePath: string;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

const DEFAULTS = {
  maxAttempts: 10,
  backoffBaseMs: 2_000,
  backoffMaxMs: 30_000,
};

export class PrintQueue {
  private jobs = new Map<string, PrintJob>();
  private readonly options: Required<Omit<PrintQueueOptions, 'filePath'>> & {
    filePath: string;
  };
  /** Serializa los guardados: dos escrituras a la vez se pisarían. */
  private escrituraEnCurso: Promise<void> = Promise.resolve();

  constructor(options: PrintQueueOptions) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Carga lo pendiente del disco. Se llama al arrancar el agente. */
  async load(): Promise<number> {
    try {
      const contenido = await readFile(this.options.filePath, 'utf8');
      const filas = JSON.parse(contenido) as PrintJob[];
      this.jobs = new Map(filas.map((j) => [j.id, j]));

      // Lo que quedó «imprimiendo» al morir el proceso vuelve a la cola: nadie
      // está esperando su resultado y quedarse ahí es no imprimirse nunca.
      let recuperados = 0;
      for (const job of this.jobs.values()) {
        if (job.status === 'printing') {
          job.status = 'pending';
          recuperados++;
        }
      }
      if (recuperados > 0) await this.persist();
      return this.jobs.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      // Un fichero corrupto no puede impedir que el agente arranque: sin él,
      // el local se queda sin imprimir NADA. Se avisa y se empieza limpio.
      throw new Error(
        `La cola de impresión en ${this.options.filePath} no se pudo leer: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Encola un trabajo. El `id` lo pone quien llama (la PWA) y sirve de clave
   * de idempotencia: pulsar «imprimir comanda» dos veces no saca dos comandas.
   */
  async enqueue(job: {
    id: string;
    printer: string;
    payload: Buffer;
    kind: string;
    reference: string;
    now?: number;
  }): Promise<PrintJob> {
    const existente = this.jobs.get(job.id);
    if (existente) return existente;

    const ahora = job.now ?? Date.now();
    const nuevo: PrintJob = {
      id: job.id,
      printer: job.printer,
      payloadBase64: job.payload.toString('base64'),
      kind: job.kind,
      reference: job.reference,
      status: 'pending',
      attempts: 0,
      createdAt: ahora,
      nextAttemptAt: ahora,
    };
    this.jobs.set(job.id, nuevo);
    await this.persist();
    return nuevo;
  }

  /** Siguiente trabajo listo para intentar, en orden de llegada. */
  nextPending(now = Date.now()): PrintJob | undefined {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'pending' && j.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  async markPrinting(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'printing';
    await this.persist();
  }

  async markDone(id: string, now = Date.now()): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'done';
    job.printedAt = now;
    job.lastError = undefined;
    await this.persist();
  }

  /**
   * Falló el intento. Vuelve a `pending` con backoff; tras agotar los intentos
   * queda en `failed`, que NO significa descartado: sigue reimprimible.
   */
  async markFailed(id: string, error: string, now = Date.now()): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.attempts++;
    job.lastError = error;
    job.status =
      job.attempts >= this.options.maxAttempts ? 'failed' : 'pending';
    job.nextAttemptAt =
      now +
      Math.min(
        this.options.backoffBaseMs * 2 ** (job.attempts - 1),
        this.options.backoffMaxMs,
      );
    await this.persist();
  }

  /**
   * Reimprime un trabajo ya terminado o fallido.
   *
   * Es la función que más se usa en la vida real del local: la comanda salió
   * con papel arrugado, el repartidor perdió la precuenta. Reimprimir crea un
   * trabajo NUEVO en vez de reciclar el viejo, para que el histórico conserve
   * que se imprimió dos veces y cuándo.
   */
  async reprint(
    id: string,
    newId: string,
    now = Date.now(),
  ): Promise<PrintJob> {
    const original = this.jobs.get(id);
    if (!original) {
      throw new Error(`No existe el trabajo de impresión ${id}.`);
    }
    return this.enqueue({
      id: newId,
      printer: original.printer,
      payload: Buffer.from(original.payloadBase64, 'base64'),
      kind: original.kind,
      reference: original.reference,
      now,
    });
  }

  get(id: string): PrintJob | undefined {
    return this.jobs.get(id);
  }

  all(): PrintJob[] {
    return [...this.jobs.values()];
  }

  pendingCount(): number {
    return this.all().filter(
      (j) => j.status === 'pending' || j.status === 'printing',
    ).length;
  }

  failed(): PrintJob[] {
    return this.all().filter((j) => j.status === 'failed');
  }

  /** Limpia lo impreso hace más de `maxAgeMs`, conservando los fallidos. */
  async purgeDone(maxAgeMs: number, now = Date.now()): Promise<number> {
    let borrados = 0;
    for (const [id, job] of this.jobs) {
      if (job.status === 'done' && now - (job.printedAt ?? 0) > maxAgeMs) {
        this.jobs.delete(id);
        borrados++;
      }
    }
    if (borrados > 0) await this.persist();
    return borrados;
  }

  /**
   * Guarda la cola de forma ATÓMICA: se escribe un temporal y se renombra.
   *
   * Un corte de luz durante el guardado dejaría el JSON a medias y la cola
   * entera ilegible — se perderían todos los pendientes, no solo el que se
   * estaba escribiendo. `rename` en el mismo sistema de ficheros es atómico.
   */
  private async persist(): Promise<void> {
    // Se encadena para que dos guardados simultáneos no se pisen.
    this.escrituraEnCurso = this.escrituraEnCurso.then(async () => {
      await mkdir(dirname(this.options.filePath), { recursive: true });
      const temporal = `${this.options.filePath}.tmp`;
      await writeFile(temporal, JSON.stringify(this.all()), 'utf8');
      await rename(temporal, this.options.filePath);
    });
    return this.escrituraEnCurso;
  }
}
