/**
 * Cola de sincronización del POS offline (ADR-0008, RN-T07).
 *
 * Es lógica PURA a propósito. La PWA la persiste en IndexedDB, pero las reglas
 * —qué se manda primero, cuándo se reintenta, cuándo se da por perdido— no
 * dependen del almacenamiento y son justo lo que puede romperse de forma
 * silenciosa. Aquí se pueden probar sin navegador y con el reloj en la mano.
 *
 * La regla que gobierna todo el diseño es RN-T07: **la venta offline nunca se
 * rechaza al sincronizar**. El cliente ya se fue con su comida y su boleta; el
 * servidor no puede decidir tres horas después que ese pedido no existió. Por
 * eso la cola no tiene estado «rechazado»: tiene `synced` y tiene
 * `needs_attention`, que significa «entró, pero mira esto».
 */

export type SyncItemStatus =
  | 'pending'
  | 'in_flight'
  | 'synced'
  /** Entró en el servidor pero con una inconsistencia que alguien debe mirar. */
  | 'needs_attention'
  /** Agotó los reintentos. NO significa perdido: significa «pide ayuda». */
  | 'stuck';

export interface SyncItem<T = unknown> {
  /** ULID generado en el cliente. Es la clave natural del dedupe (ADR-0010). */
  readonly clientId: string;
  readonly payload: T;
  status: SyncItemStatus;
  attempts: number;
  /** Instante en que se creó en el POS, no en que se sincroniza. */
  readonly createdAt: number;
  /** No reintentar antes de este instante (backoff). */
  nextAttemptAt: number;
  lastError?: string | undefined;
}

export interface SyncQueueOptions {
  /** Intentos antes de marcar `stuck` y pedir intervención. */
  maxAttempts?: number;
  /** Base del backoff exponencial, en milisegundos. */
  backoffBaseMs?: number;
  /** Tope del backoff: sin él, tras varios fallos se esperarían horas. */
  backoffMaxMs?: number;
}

export const DEFAULT_SYNC_OPTIONS: Required<SyncQueueOptions> = {
  maxAttempts: 8,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
};

/**
 * Espera antes del siguiente intento. Exponencial con tope.
 *
 * El tope no es cosmético: sin él, ocho fallos seguidos (una tarde sin
 * internet, que es el caso normal, no el raro) dejarían el siguiente intento a
 * cuatro horas vista, y al volver la red el local seguiría sin sincronizar.
 */
export function backoffFor(
  attempts: number,
  options: SyncQueueOptions = {},
): number {
  const { backoffBaseMs, backoffMaxMs } = {
    ...DEFAULT_SYNC_OPTIONS,
    ...options,
  };
  const espera = backoffBaseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(espera, backoffMaxMs);
}

export class SyncQueue<T = unknown> {
  private readonly items = new Map<string, SyncItem<T>>();
  private readonly options: Required<SyncQueueOptions>;

  constructor(options: SyncQueueOptions = {}) {
    this.options = { ...DEFAULT_SYNC_OPTIONS, ...options };
  }

  /**
   * Encola un pedido vendido sin red.
   *
   * Encolar el MISMO `clientId` dos veces no duplica: devuelve el que ya
   * estaba. En el POS esto pasa de verdad —el cajero pulsa «cobrar» dos veces
   * porque la pantalla no respondió— y duplicar aquí sería duplicar la venta.
   */
  enqueue(clientId: string, payload: T, createdAt: number): SyncItem<T> {
    const existente = this.items.get(clientId);
    if (existente) return existente;

    const item: SyncItem<T> = {
      clientId,
      payload,
      status: 'pending',
      attempts: 0,
      createdAt,
      nextAttemptAt: createdAt,
    };
    this.items.set(clientId, item);
    return item;
  }

  /**
   * Siguiente lote a enviar, en ORDEN DE VENTA.
   *
   * El orden importa: los números de pedido y el arqueo del turno se leen en
   * el orden en que ocurrieron las cosas, no en el que la red quiso.
   */
  nextBatch(now: number, limit = 25): Array<SyncItem<T>> {
    return [...this.items.values()]
      .filter(
        (i) =>
          (i.status === 'pending' || i.status === 'stuck') &&
          i.nextAttemptAt <= now,
      )
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || a.clientId.localeCompare(b.clientId),
      )
      .slice(0, limit);
  }

  /** Marca un lote como en vuelo para no reenviarlo mientras espera respuesta. */
  markInFlight(clientIds: readonly string[]): void {
    for (const id of clientIds) {
      const item = this.items.get(id);
      if (item) item.status = 'in_flight';
    }
  }

  /** El servidor lo aceptó (o ya lo tenía: para la cola es lo mismo). */
  markSynced(clientId: string): void {
    const item = this.items.get(clientId);
    if (!item) return;
    item.status = 'synced';
    item.lastError = undefined;
  }

  /**
   * Entró en el servidor con una inconsistencia (RN-T07). NO es un fallo de
   * sincronización: el pedido está, pero alguien tiene que mirarlo. Se separa
   * de `synced` para que la PWA pueda mostrarlo sin volver a enviarlo.
   */
  markNeedsAttention(clientId: string, motivo: string): void {
    const item = this.items.get(clientId);
    if (!item) return;
    item.status = 'needs_attention';
    item.lastError = motivo;
  }

  /**
   * Falló el envío (red caída, servidor 500). Vuelve a `pending` con backoff;
   * tras agotar los intentos pasa a `stuck`, que **sigue siendo reintentable**
   * a mano. Nunca se descarta: descartar es perder una venta cobrada.
   */
  markFailed(clientId: string, error: string, now: number): void {
    const item = this.items.get(clientId);
    if (!item) return;
    item.attempts++;
    item.lastError = error;
    item.status =
      item.attempts >= this.options.maxAttempts ? 'stuck' : 'pending';
    item.nextAttemptAt = now + backoffFor(item.attempts, this.options);
  }

  /**
   * Devuelve a la cola todo lo que quedó «en vuelo».
   *
   * Se llama al arrancar la PWA: si el navegador se cerró con una petición a
   * medias, esos pedidos quedaron marcados como enviándose y sin nadie
   * esperando su respuesta. Sin esto se quedarían ahí para siempre — sin
   * sincronizar y sin que nadie lo note.
   */
  recoverInFlight(now: number): number {
    let recuperados = 0;
    for (const item of this.items.values()) {
      if (item.status === 'in_flight') {
        item.status = 'pending';
        item.nextAttemptAt = now;
        recuperados++;
      }
    }
    return recuperados;
  }

  get(clientId: string): SyncItem<T> | undefined {
    return this.items.get(clientId);
  }

  all(): Array<SyncItem<T>> {
    return [...this.items.values()];
  }

  /** Cuántos quedan por sincronizar. El POS lo muestra en pantalla. */
  pendingCount(): number {
    return this.all().filter(
      (i) => i.status !== 'synced' && i.status !== 'needs_attention',
    ).length;
  }

  /**
   * ¿Se puede cerrar la caja? (spec 06: «cierre con offline pendiente →
   * bloqueado con aviso»). Cerrar un turno con ventas sin sincronizar produce
   * un arqueo que no cuadra con lo que el servidor acabará teniendo.
   */
  canCloseShift(): { ok: boolean; pending: number } {
    const pending = this.pendingCount();
    return { ok: pending === 0, pending };
  }

  /** Elimina lo ya sincronizado para que IndexedDB no crezca sin fin. */
  purgeSynced(): number {
    let borrados = 0;
    for (const [id, item] of this.items) {
      if (item.status === 'synced') {
        this.items.delete(id);
        borrados++;
      }
    }
    return borrados;
  }

  /** Serializa para persistir en IndexedDB. */
  toJSON(): Array<SyncItem<T>> {
    return this.all();
  }

  /** Restaura desde IndexedDB al arrancar. */
  static fromJSON<T>(
    items: ReadonlyArray<SyncItem<T>>,
    options: SyncQueueOptions = {},
  ): SyncQueue<T> {
    const cola = new SyncQueue<T>(options);
    for (const item of items) {
      cola.items.set(item.clientId, { ...item });
    }
    return cola;
  }
}
