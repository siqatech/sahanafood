import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SyncQueue,
  backoffFor,
  DEFAULT_SYNC_OPTIONS,
  type SyncItem,
} from './sync-queue.js';

const T0 = 1_760_000_000_000;

/**
 * Cola con tres ventas, en el orden en que ocurrieron.
 *
 * El payload es deliberadamente opaco: la cola no sabe qué transporta y no
 * debe saberlo. Los importes viven en el pedido, no aquí.
 */
function colaConVentas(): SyncQueue<{ ref: string }> {
  const cola = new SyncQueue<{ ref: string }>();
  cola.enqueue('01J000000000000000000000A', { ref: 'venta-1' }, T0);
  cola.enqueue('01J000000000000000000000B', { ref: 'venta-2' }, T0 + 1_000);
  cola.enqueue('01J000000000000000000000C', { ref: 'venta-3' }, T0 + 2_000);
  return cola;
}

describe('Cola de sincronización offline', () => {
  it('encolar el MISMO clientId dos veces no duplica la venta', () => {
    // Pasa de verdad: el cajero pulsa «cobrar» dos veces porque la pantalla no
    // respondió. Duplicar aquí sería duplicar el cobro.
    const cola = new SyncQueue<{ ref: string }>();
    cola.enqueue('01J-DUP', { ref: 'venta-1' }, T0);
    cola.enqueue('01J-DUP', { ref: 'venta-repetida' }, T0 + 500);

    expect(cola.all()).toHaveLength(1);
    expect(cola.get('01J-DUP')!.payload.ref).toBe('venta-1');
  });

  it('el lote sale en ORDEN DE VENTA, no en el que la red quiera', () => {
    // Los números de pedido y el arqueo se leen en el orden en que ocurrieron
    // las cosas.
    const cola = new SyncQueue<{ ref: string }>();
    cola.enqueue('zzz', { ref: 'c' }, T0 + 2_000);
    cola.enqueue('aaa', { ref: 'a' }, T0);
    cola.enqueue('mmm', { ref: 'b' }, T0 + 1_000);

    expect(cola.nextBatch(T0 + 10_000).map((i) => i.clientId)).toEqual([
      'aaa',
      'mmm',
      'zzz',
    ]);
  });

  it('respeta el límite del lote', () => {
    const cola = colaConVentas();
    expect(cola.nextBatch(T0 + 10_000, 2)).toHaveLength(2);
  });

  it('lo que está en vuelo no se reenvía', () => {
    const cola = colaConVentas();
    const lote = cola.nextBatch(T0 + 10_000);
    cola.markInFlight(lote.map((i) => i.clientId));
    expect(cola.nextBatch(T0 + 10_000)).toEqual([]);
  });

  it('un fallo reintenta con backoff creciente', () => {
    const cola = colaConVentas();
    cola.markFailed('01J000000000000000000000A', 'sin red', T0);

    const item = cola.get('01J000000000000000000000A')!;
    expect(item.status).toBe('pending');
    expect(item.attempts).toBe(1);
    // Todavía no toca: el backoff lo aparta del siguiente lote.
    expect(
      cola.nextBatch(T0).map((i) => i.clientId),
    ).not.toContain('01J000000000000000000000A');
    expect(cola.nextBatch(item.nextAttemptAt).map((i) => i.clientId)).toContain(
      '01J000000000000000000000A',
    );
  });

  it('el backoff tiene TOPE: una tarde sin internet no lo manda a horas vista', () => {
    // Sin tope, ocho fallos seguidos dejarían el siguiente intento a cuatro
    // horas, y al volver la red el local seguiría sin sincronizar.
    expect(backoffFor(1)).toBe(1_000);
    expect(backoffFor(2)).toBe(2_000);
    expect(backoffFor(20)).toBe(DEFAULT_SYNC_OPTIONS.backoffMaxMs);
  });

  it('tras agotar intentos queda STUCK, pero NUNCA se descarta', () => {
    // Descartar es perder una venta ya cobrada. `stuck` significa «pide
    // ayuda», no «se acabó».
    const cola = new SyncQueue<{ ref: string }>({ maxAttempts: 3 });
    cola.enqueue('x', { ref: 'a' }, T0);
    for (let i = 0; i < 3; i++) cola.markFailed('x', 'sin red', T0);

    const item = cola.get('x')!;
    expect(item.status).toBe('stuck');
    expect(cola.all()).toHaveLength(1);
    // Y sigue siendo reintentable.
    expect(
      cola.nextBatch(item.nextAttemptAt).map((i) => i.clientId),
    ).toContain('x');
  });

  it('recupera lo que quedó EN VUELO al cerrarse el navegador', () => {
    // Si el navegador se cerró con una petición a medias, esos pedidos
    // quedarían marcados como enviándose y sin nadie esperando su respuesta:
    // sin sincronizar y sin que nadie lo note.
    const cola = colaConVentas();
    cola.markInFlight(['01J000000000000000000000A']);
    expect(cola.recoverInFlight(T0 + 5_000)).toBe(1);
    expect(cola.get('01J000000000000000000000A')!.status).toBe('pending');
  });

  it('needs_attention NO se reenvía: el pedido ya entró', () => {
    // RN-T07: entró con una inconsistencia. Reenviarlo sería intentar crear
    // otra vez algo que ya existe.
    const cola = colaConVentas();
    cola.markNeedsAttention('01J000000000000000000000A', 'Producto retirado');

    expect(cola.nextBatch(T0 + 10_000).map((i) => i.clientId)).not.toContain(
      '01J000000000000000000000A',
    );
    expect(cola.get('01J000000000000000000000A')!.lastError).toContain(
      'Producto retirado',
    );
  });

  it('NO se cierra la caja con ventas sin sincronizar', () => {
    // Cerrar el turno con ventas pendientes produce un arqueo que no cuadra
    // con lo que el servidor acabará teniendo (spec 06).
    const cola = colaConVentas();
    expect(cola.canCloseShift()).toEqual({ ok: false, pending: 3 });

    for (const id of cola.all().map((i) => i.clientId)) cola.markSynced(id);
    expect(cola.canCloseShift()).toEqual({ ok: true, pending: 0 });
  });

  it('needs_attention no impide cerrar: el pedido está en el servidor', () => {
    const cola = colaConVentas();
    cola.markSynced('01J000000000000000000000A');
    cola.markSynced('01J000000000000000000000B');
    cola.markNeedsAttention('01J000000000000000000000C', 'Precio cambiado');
    expect(cola.canCloseShift().ok).toBe(true);
  });

  it('purga lo sincronizado y conserva lo que falta', () => {
    const cola = colaConVentas();
    cola.markSynced('01J000000000000000000000A');
    cola.markNeedsAttention('01J000000000000000000000B', 'ojo');

    expect(cola.purgeSynced()).toBe(1);
    expect(cola.all().map((i) => i.clientId).sort()).toEqual([
      '01J000000000000000000000B',
      '01J000000000000000000000C',
    ]);
  });

  it('sobrevive al reinicio: se serializa y se restaura entera', () => {
    const cola = colaConVentas();
    cola.markFailed('01J000000000000000000000A', 'sin red', T0);

    const restaurada = SyncQueue.fromJSON(
      JSON.parse(JSON.stringify(cola.toJSON())) as SyncItem<{ ref: string }>[],
    );
    expect(restaurada.all()).toHaveLength(3);
    expect(restaurada.get('01J000000000000000000000A')!.attempts).toBe(1);
    expect(restaurada.pendingCount()).toBe(3);
  });

  it('PROPIEDAD: ninguna venta encolada desaparece jamás', () => {
    // La propiedad que de verdad importa: pase lo que pase —fallos,
    // reintentos, reinicios—, toda venta encolada sigue en la cola hasta que
    // el servidor confirma que la tiene.
    const acciones = fc.array(
      fc.oneof(
        fc.constant('fail' as const),
        fc.constant('inflight' as const),
        fc.constant('recover' as const),
        fc.constant('attention' as const),
      ),
      { maxLength: 30 },
    );

    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), {
          minLength: 1,
          maxLength: 10,
        }),
        acciones,
        (ids, secuencia) => {
          const cola = new SyncQueue<number>({ maxAttempts: 3 });
          const unicos = [...new Set(ids)];
          unicos.forEach((id, i) => cola.enqueue(id, i, T0 + i));

          let t = T0;
          for (const accion of secuencia) {
            t += 100;
            const objetivo = unicos[t % unicos.length]!;
            if (accion === 'fail') cola.markFailed(objetivo, 'x', t);
            else if (accion === 'inflight') cola.markInFlight([objetivo]);
            else if (accion === 'recover') cola.recoverInFlight(t);
            else cola.markNeedsAttention(objetivo, 'ojo');
          }

          // Sin marcar nada como sincronizado, no puede faltar ninguna.
          expect(cola.all()).toHaveLength(unicos.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
