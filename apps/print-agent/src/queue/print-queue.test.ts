import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrintQueue } from './print-queue.js';
import { PrintDispatcher } from './dispatcher.js';
import type { PrinterTransport } from '../transport/printer.js';

/**
 * La cola existe porque una térmica falla de formas que no son «error de red»:
 * se queda sin papel a media comanda, alguien la apaga para enchufar otra
 * cosa. Sin cola, cada uno de esos casos es una comanda que la cocina nunca
 * vio y un pedido que nadie prepara.
 */

const T0 = 1_760_000_000_000;
let dir = '';
let ruta = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sahana-print-'));
  ruta = join(dir, 'cola.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const nuevaCola = (opciones = {}) =>
  new PrintQueue({ filePath: ruta, ...opciones });

const trabajo = (id: string, printer = 'cocina') => ({
  id,
  printer,
  payload: Buffer.from([0x1b, 0x40, 0x41]),
  kind: 'kitchen_ticket',
  reference: '#42',
  now: T0,
});

/** Impresora falsa que se puede romper y arreglar a voluntad. */
class ImpresoraFalsa implements PrinterTransport {
  readonly recibido: Buffer[] = [];
  fallar: string | null = null;
  constructor(readonly name = 'cocina') {}
  async send(payload: Buffer): Promise<void> {
    if (this.fallar) throw new Error(this.fallar);
    this.recibido.push(payload);
  }
  async probe(): Promise<boolean> {
    return this.fallar === null;
  }
}

describe('Cola de impresión', () => {
  it('persiste EN DISCO antes de intentar imprimir', async () => {
    // Un trabajo solo en memoria es un trabajo perdido: el motivo habitual de
    // reinicio en un local es un corte de luz.
    const cola = nuevaCola();
    await cola.enqueue(trabajo('j1'));

    const guardado = JSON.parse(await readFile(ruta, 'utf8')) as unknown[];
    expect(guardado).toHaveLength(1);
  });

  it('sobrevive al reinicio del agente', async () => {
    const primera = nuevaCola();
    await primera.enqueue(trabajo('j1'));
    await primera.enqueue(trabajo('j2'));

    const segunda = nuevaCola();
    expect(await segunda.load()).toBe(2);
    expect(segunda.pendingCount()).toBe(2);
  });

  it('lo que quedó IMPRIMIENDO al morir el proceso vuelve a la cola', async () => {
    // Nadie está esperando su resultado: quedarse ahí es no imprimirse nunca.
    const primera = nuevaCola();
    await primera.enqueue(trabajo('j1'));
    await primera.markPrinting('j1');

    const segunda = nuevaCola();
    await segunda.load();
    expect(segunda.get('j1')!.status).toBe('pending');
  });

  it('encolar el mismo id dos veces NO saca dos comandas', async () => {
    // Pulsar «imprimir» dos veces porque la primera pareció no responder es lo
    // más normal del mundo en un mostrador.
    const cola = nuevaCola();
    await cola.enqueue(trabajo('j1'));
    await cola.enqueue(trabajo('j1'));
    expect(cola.all()).toHaveLength(1);
  });

  it('la escritura es ATÓMICA: no deja el fichero a medias', async () => {
    // Un corte de luz durante el guardado dejaría el JSON ilegible y se
    // perderían TODOS los pendientes, no solo el que se estaba escribiendo.
    const cola = nuevaCola();
    await Promise.all([
      cola.enqueue(trabajo('j1')),
      cola.enqueue(trabajo('j2')),
      cola.enqueue(trabajo('j3')),
    ]);

    const contenido = await readFile(ruta, 'utf8');
    expect(() => JSON.parse(contenido)).not.toThrow();
    expect(JSON.parse(contenido)).toHaveLength(3);
  });

  it('un fallo reintenta con backoff y NUNCA descarta', async () => {
    const cola = nuevaCola({ maxAttempts: 3 });
    await cola.enqueue(trabajo('j1'));

    await cola.markFailed('j1', 'sin papel', T0);
    expect(cola.get('j1')!.status).toBe('pending');
    // El backoff lo aparta del siguiente intento inmediato.
    expect(cola.nextPending(T0)).toBeUndefined();
    expect(cola.nextPending(cola.get('j1')!.nextAttemptAt)?.id).toBe('j1');

    await cola.markFailed('j1', 'sin papel', T0);
    await cola.markFailed('j1', 'sin papel', T0);
    expect(cola.get('j1')!.status).toBe('failed');
    // Fallido NO es descartado: sigue ahí para reimprimir a mano.
    expect(cola.all()).toHaveLength(1);
    expect(cola.failed()).toHaveLength(1);
  });

  it('reimprimir crea un trabajo NUEVO y conserva el histórico', async () => {
    // La comanda salió con papel arrugado, el repartidor perdió la precuenta:
    // es la función que más se usa en la vida real del local.
    const cola = nuevaCola();
    await cola.enqueue(trabajo('j1'));
    await cola.markDone('j1', T0);

    const copia = await cola.reprint('j1', 'j1-copia', T0 + 1_000);
    expect(copia.id).toBe('j1-copia');
    expect(copia.status).toBe('pending');
    expect(copia.payloadBase64).toBe(cola.get('j1')!.payloadBase64);
    // El original sigue marcado como impreso: queda constancia de las dos.
    expect(cola.get('j1')!.status).toBe('done');
  });

  it('reimprimir algo que no existe falla en vez de imprimir en blanco', async () => {
    const cola = nuevaCola();
    await expect(cola.reprint('inexistente', 'x')).rejects.toThrow(
      /No existe el trabajo/,
    );
  });

  it('la purga se lleva lo impreso viejo y CONSERVA los fallidos', async () => {
    const cola = nuevaCola({ maxAttempts: 1 });
    await cola.enqueue(trabajo('viejo'));
    await cola.markDone('viejo', T0);
    await cola.enqueue({ ...trabajo('roto'), id: 'roto' });
    await cola.markFailed('roto', 'sin papel', T0);

    expect(await cola.purgeDone(60_000, T0 + 120_000)).toBe(1);
    expect(cola.all().map((j) => j.id)).toEqual(['roto']);
  });

  it('un fichero corrupto se reporta en vez de arrancar en silencio', async () => {
    // Si el agente arrancara con la cola vacía y sin avisar, el local creería
    // que todo está bien mientras las comandas pendientes ya no existen.
    await writeFile(ruta, '{ esto no es json', 'utf8');
    await expect(nuevaCola().load()).rejects.toThrow(/no se pudo leer/);
  });

  it('una cola inexistente arranca vacía sin protestar', async () => {
    expect(await nuevaCola().load()).toBe(0);
  });
});

describe('Despachador', () => {
  it('imprime lo pendiente y lo marca hecho', async () => {
    const cola = nuevaCola();
    const impresora = new ImpresoraFalsa();
    const despachador = new PrintDispatcher(
      cola,
      new Map([['cocina', impresora]]),
    );

    await cola.enqueue(trabajo('j1'));
    const r = await despachador.drain(10, T0);

    expect(r).toEqual({ processed: 1, printed: 1, failed: 0 });
    expect(impresora.recibido).toHaveLength(1);
    expect(cola.get('j1')!.status).toBe('done');
  });

  it('un fallo de impresora deja el trabajo para el siguiente intento', async () => {
    const cola = nuevaCola();
    const impresora = new ImpresoraFalsa();
    impresora.fallar = 'La impresora no respondió. ¿Está encendida?';
    const despachador = new PrintDispatcher(
      cola,
      new Map([['cocina', impresora]]),
    );

    await cola.enqueue(trabajo('j1'));
    const r = await despachador.drain(10, T0);
    expect(r.failed).toBe(1);
    expect(cola.get('j1')!.status).toBe('pending');
    expect(cola.get('j1')!.lastError).toContain('encendida');

    // Se arregla la impresora y la siguiente vuelta la saca.
    impresora.fallar = null;
    const reintento = await despachador.drain(
      10,
      cola.get('j1')!.nextAttemptAt,
    );
    expect(reintento.printed).toBe(1);
    expect(cola.get('j1')!.status).toBe('done');
  });

  it('una impresora sin configurar no rompe el agente', async () => {
    const cola = nuevaCola();
    const despachador = new PrintDispatcher(cola, new Map());
    await cola.enqueue(trabajo('j1', 'inexistente'));

    const r = await despachador.drain(10, T0);
    expect(r.failed).toBe(1);
    expect(cola.get('j1')!.lastError).toContain(
      'ninguna impresora configurada',
    );
  });

  it('va de UNO EN UNO: dos trabajos no se intercalan en el papel', async () => {
    // Si se mandan a la vez, los bytes se mezclan y salen dos tickets
    // superpuestos, que es peor que no imprimir ninguno.
    const cola = nuevaCola();
    const orden: string[] = [];
    const impresora: PrinterTransport = {
      name: 'cocina',
      async send(payload) {
        orden.push(`inicio-${payload.length}`);
        await new Promise((r) => setTimeout(r, 5));
        orden.push(`fin-${payload.length}`);
      },
      async probe() {
        return true;
      },
    };

    await cola.enqueue({ ...trabajo('j1'), payload: Buffer.from([1]) });
    await cola.enqueue({ ...trabajo('j2'), payload: Buffer.from([1, 2]) });
    await new PrintDispatcher(cola, new Map([['cocina', impresora]])).drain(
      10,
      T0,
    );

    expect(orden).toEqual(['inicio-1', 'fin-1', 'inicio-2', 'fin-2']);
  });

  it('dos despachos SOLAPADOS no sacan la misma comanda dos veces', async () => {
    // Al agente le entran dos disparos a la vez: el bucle de reintentos cada
    // 5 s y el que provoca cada petición de la PWA. `nextPending()` es
    // síncrono, así que sin serializar ambos eligen el MISMO trabajo antes de
    // que ninguno llegue a marcarlo, y la comanda sale por duplicado.
    const cola = nuevaCola();
    const impresora = new ImpresoraFalsa();
    const despachador = new PrintDispatcher(
      cola,
      new Map([['cocina', impresora]]),
    );

    await cola.enqueue(trabajo('j1'));
    const [a, b] = await Promise.all([
      despachador.drain(10, T0),
      despachador.drain(10, T0),
    ]);

    expect(impresora.recibido).toHaveLength(1);
    expect(a!.printed + b!.printed).toBe(1);
    expect(cola.get('j1')!.status).toBe('done');
  });

  it('idle() espera al despacho en curso: apagar a media comanda parte el papel', async () => {
    const cola = nuevaCola();
    let terminado = false;
    const impresora: PrinterTransport = {
      name: 'cocina',
      async send() {
        await new Promise((r) => setTimeout(r, 10));
        terminado = true;
      },
      async probe() {
        return true;
      },
    };
    const despachador = new PrintDispatcher(
      cola,
      new Map([['cocina', impresora]]),
    );

    await cola.enqueue(trabajo('j1'));
    void despachador.drain(10, T0);
    await despachador.idle();

    expect(terminado).toBe(true);
  });

  it('un despacho que revienta no envenena el turno siguiente', async () => {
    const cola = nuevaCola();
    const impresora = new ImpresoraFalsa();
    const despachador = new PrintDispatcher(
      cola,
      new Map([['cocina', impresora]]),
    );

    // La cola falla al persistir: el disco del local se llenó.
    const original = cola.markPrinting.bind(cola);
    let reventar = true;
    cola.markPrinting = async (id: string): Promise<void> => {
      if (reventar) {
        reventar = false;
        throw new Error('ENOSPC: no queda espacio en el disco');
      }
      return original(id);
    };

    await cola.enqueue(trabajo('j1'));
    await expect(despachador.drain(10, T0)).rejects.toThrow('ENOSPC');

    // El siguiente intento tiene que funcionar: si la cadena se quedase con el
    // rechazo, el agente no volvería a imprimir hasta que lo reiniciaran.
    const r = await despachador.drain(10, T0);
    expect(r.printed).toBe(1);
  });

  it('reporta la salud de cada impresora con su cola', async () => {
    const cola = nuevaCola();
    const buena = new ImpresoraFalsa('cocina');
    const rota = new ImpresoraFalsa('caja');
    rota.fallar = 'sin papel';

    await cola.enqueue(trabajo('j1', 'caja'));
    const salud = await new PrintDispatcher(
      cola,
      new Map([
        ['cocina', buena],
        ['caja', rota],
      ]),
    ).health();

    expect(salud).toEqual([
      { printer: 'cocina', reachable: true, pendingJobs: 0 },
      { printer: 'caja', reachable: false, pendingJobs: 1 },
    ]);
  });
});
