import { SyncQueue, type SyncItem } from '@sahana/domain';
import { almacen } from './db';
import { api, SinRed, type PedidoOffline } from './api';

/**
 * Sincronización de las ventas hechas sin red (T4.21, RN-T07).
 *
 * La política —qué se manda primero, cuándo se reintenta, cuándo se da por
 * atascado— vive en `SyncQueue` de `@sahana/domain`, que es lógica pura y se
 * prueba sin navegador. Aquí solo está el pegamento: cargar de IndexedDB,
 * llamar a la API y persistir el resultado.
 *
 * La regla que gobierna todo: **una venta encolada no se descarta nunca**. El
 * cliente ya se fue con su comida y su boleta; el servidor no puede decidir
 * tres horas después que ese pedido no existió. Por eso no hay estado
 * «rechazado» y por eso se borra de disco **después** de confirmar, nunca antes.
 */

export interface ResumenDeSincronizacion {
  enviados: number;
  aceptados: number;
  duplicados: number;
  fallidos: number;
  /** Entraron, pero con una inconsistencia que alguien debe mirar (RN-T07). */
  conAviso: number;
  pendientes: number;
  sinRed: boolean;
}

/** Carga la cola de IndexedDB a la cola de dominio. */
async function cargarCola(): Promise<SyncQueue<PedidoOffline>> {
  const cola = new SyncQueue<PedidoOffline>();
  for (const item of await almacen.cola()) {
    const encolado = cola.enqueue(item.clientId, item.payload, item.createdAt);
    // `enqueue` crea el elemento en estado inicial: aquí se restaura el que
    // tenía en disco, incluidos sus intentos y su espera.
    encolado.status = item.status;
    encolado.attempts = item.attempts;
    encolado.nextAttemptAt = item.nextAttemptAt;
    encolado.lastError = item.lastError;
  }
  return cola;
}

async function persistir(items: Array<SyncItem<PedidoOffline>>): Promise<void> {
  for (const item of items) await almacen.guardarEnCola(item);
}

/** Encola una venta. Es lo ÚNICO que ocurre al cobrar: ni una llamada de red. */
export async function encolarVenta(pedido: PedidoOffline): Promise<void> {
  await almacen.guardarEnCola({
    clientId: pedido.clientId,
    payload: pedido,
    status: 'pending',
    attempts: 0,
    createdAt: Date.parse(pedido.soldAt),
    nextAttemptAt: Date.parse(pedido.soldAt),
  });
}

export async function pendientes(): Promise<number> {
  const cola = await cargarCola();
  return cola.pendingCount();
}

/**
 * Una vuelta de sincronización.
 *
 * Se llama al arrancar, al recuperar la conexión y cada pocos segundos mientras
 * quede algo. Es segura de llamar de más: lo que ya está sincronizado no se
 * reenvía, y lo que se reenvía por error choca contra el dedupe del servidor y
 * vuelve como `duplicate`, que para la cola es lo mismo que aceptado.
 */
export async function sincronizarUnaVez(
  accessToken: string,
  ahora: number = Date.now(),
): Promise<ResumenDeSincronizacion> {
  const cola = await cargarCola();

  // Lo que quedó «en vuelo» de una sesión anterior vuelve a la cola: si el
  // navegador se cerró con una petición a medias, nadie espera ya su respuesta
  // y sin esto se quedaría ahí para siempre, sin sincronizar y sin avisar.
  if (cola.recoverInFlight(ahora) > 0) await persistir(cola.all());

  const lote = cola.nextBatch(ahora);
  if (lote.length === 0) {
    return {
      enviados: 0,
      aceptados: 0,
      duplicados: 0,
      fallidos: 0,
      conAviso: 0,
      pendientes: cola.pendingCount(),
      sinRed: false,
    };
  }

  cola.markInFlight(lote.map((i) => i.clientId));
  await persistir(cola.all());

  let respuesta;
  try {
    respuesta = await api.sincronizar(
      accessToken,
      lote.map((i) => i.payload),
    );
  } catch (error) {
    const motivo = error instanceof Error ? error.message : String(error);
    for (const item of lote) cola.markFailed(item.clientId, motivo, ahora);
    await persistir(cola.all());
    return {
      enviados: lote.length,
      aceptados: 0,
      duplicados: 0,
      fallidos: lote.length,
      conAviso: 0,
      pendientes: cola.pendingCount(),
      sinRed: error instanceof SinRed,
    };
  }

  let conAviso = 0;
  for (const r of respuesta.results) {
    if (r.error) {
      cola.markFailed(r.clientId, r.error, ahora);
      continue;
    }
    if (r.alerts && r.alerts.length > 0) {
      // Entró, pero con una inconsistencia. NO se reenvía —el pedido está en el
      // servidor— y NO se borra: alguien tiene que mirarlo.
      cola.markNeedsAttention(r.clientId, r.alerts.join(' · '));
      conAviso++;
      continue;
    }
    cola.markSynced(r.clientId);
  }

  await persistir(cola.all());
  // Se purga DESPUÉS de confirmar. Borrar al enviar y perder la respuesta haría
  // desaparecer del dispositivo una venta que no está en el servidor.
  await almacen.purgarSincronizados();

  return {
    enviados: lote.length,
    aceptados: respuesta.accepted,
    duplicados: respuesta.duplicates,
    fallidos: respuesta.failed,
    conAviso,
    pendientes: cola.pendingCount(),
    sinRed: false,
  };
}
