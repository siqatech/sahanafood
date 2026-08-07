import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentServer } from './server.js';
import { PrintQueue } from '../queue/print-queue.js';
import { PrintDispatcher } from '../queue/dispatcher.js';
import type { PrinterTransport } from '../transport/printer.js';

/** Impresora de mentira que guarda lo que le mandan. */
class ImpresoraEspia implements PrinterTransport {
  readonly name = 'cocina';
  readonly recibido: Buffer[] = [];
  fallar = false;

  async send(payload: Buffer): Promise<void> {
    if (this.fallar) throw new Error('Sin papel');
    this.recibido.push(payload);
  }

  async probe(): Promise<boolean> {
    return !this.fallar;
  }
}

const TOKEN = 'token-de-emparejamiento-de-la-caja-1';

const COMANDA = {
  printer: 'cocina',
  orderNumber: 1042,
  brandName: 'Sahana Burgers',
  stationName: 'Plancha',
  channel: 'delivery',
  lines: [{ quantity: 2, productName: 'Hamburguesa clásica' }],
};

const PRECUENTA = {
  printer: 'cocina',
  orderNumber: 1042,
  brandName: 'Sahana Burgers',
  locationName: 'Miraflores',
  lines: [
    { quantity: 2, productName: 'Hamburguesa clásica', lineTotal: 'S/ 45.80' },
  ],
  subtotal: 'S/ 45.80',
  total: 'S/ 45.80',
  taxLabel: 'IGV incluido (18%)',
  tax: 'S/ 6.98',
};

describe('API local del agente de impresión', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let queue: PrintQueue;
  let impresora: ImpresoraEspia;
  let dispatcher: PrintDispatcher;
  let erroresDeFondo: unknown[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agente-api-'));
    queue = new PrintQueue({ filePath: join(dir, 'cola.json') });
    impresora = new ImpresoraEspia();
    erroresDeFondo = [];
    dispatcher = new PrintDispatcher(
      queue,
      new Map<string, PrinterTransport>([['cocina', impresora]]),
    );

    server = createAgentServer({
      queue,
      dispatcher,
      pairingToken: TOKEN,
      now: () => new Date('2026-08-07T20:12:00Z'),
      onError: (error) => erroresDeFondo.push(error),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Los despachos van en segundo plano: borrar el directorio sin esperarlos
    // les quitaría el fichero de la cola de debajo de los pies.
    await dispatcher.idle();
    await rm(dir, { recursive: true, force: true });
    expect(erroresDeFondo).toEqual([]);
  });

  const post = (ruta: string, body: unknown, token: string | null = TOKEN) =>
    fetch(`${base}${ruta}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-agent-token': token } : {}),
      },
      body: JSON.stringify(body),
    });

  it('/health responde sin token: la PWA la consulta antes de emparejarse', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const cuerpo = (await res.json()) as {
      status: string;
      pendingJobs: number;
      printers: Array<{ printer: string; reachable: boolean }>;
    };
    expect(cuerpo.status).toBe('ok');
    expect(cuerpo.pendingJobs).toBe(0);
    expect(cuerpo.printers).toEqual([
      { printer: 'cocina', reachable: true, pendingJobs: 0 },
    ]);
  });

  it('rechaza imprimir sin token', async () => {
    // El wifi de un local no es una red de confianza, y cualquier pestaña
    // abierta en el mismo navegador puede llamar a localhost.
    const res = await post('/print/kitchen', COMANDA, null);
    expect(res.status).toBe(401);
  });

  it('rechaza un token que no es el suyo, tenga la longitud que tenga', async () => {
    for (const malo of [
      'x',
      TOKEN.slice(0, -1),
      `${TOKEN}x`,
      TOKEN.toUpperCase(),
    ]) {
      const res = await post('/print/kitchen', COMANDA, malo);
      expect(res.status).toBe(401);
    }
    expect(queue.all()).toHaveLength(0);
  });

  it('acepta la comanda con 202 y la imprime', async () => {
    const res = await post('/print/kitchen', { ...COMANDA, jobId: 'j-1' });
    expect(res.status).toBe(202);
    // Se acusa recibo con el id: la PWA no espera al papel, espera al acuse.
    expect(await res.json()).toMatchObject({ jobId: 'j-1' });

    // La respuesta NO espera a la impresora; el despacho ocurre justo después.
    await vi.waitFor(() => expect(impresora.recibido).toHaveLength(1));
    expect(queue.get('j-1')!.status).toBe('done');
    expect(impresora.recibido[0]!.toString('latin1')).toContain('#1042');
  });

  it('el mismo jobId no saca dos comandas: pulsar «imprimir» dos veces es lo normal', async () => {
    await post('/print/kitchen', { ...COMANDA, jobId: 'j-1' });
    await vi.waitFor(() => expect(impresora.recibido).toHaveLength(1));

    const segunda = await post('/print/kitchen', { ...COMANDA, jobId: 'j-1' });
    expect(segunda.status).toBe(202);

    expect(queue.all()).toHaveLength(1);
    expect(impresora.recibido).toHaveLength(1);
  });

  it('la precuenta lleva el aviso de que no es comprobante', async () => {
    const res = await post('/print/precheck', { ...PRECUENTA, jobId: 'p-1' });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(impresora.recibido).toHaveLength(1));
    expect(impresora.recibido[0]!.toString('latin1')).toContain(
      'NO ES COMPROBANTE DE PAGO',
    );
  });

  it('devuelve 422 con datos inválidos y no encola nada', async () => {
    const res = await post('/print/kitchen', { ...COMANDA, lines: [] });
    expect(res.status).toBe(422);
    expect(queue.all()).toHaveLength(0);
  });

  it('conserva el trabajo cuando la impresora falla, para poder reimprimirlo', async () => {
    impresora.fallar = true;
    await post('/print/kitchen', { ...COMANDA, jobId: 'j-1' });

    await vi.waitFor(() => expect(queue.get('j-1')!.attempts).toBe(1));
    const job = queue.get('j-1')!;
    // Vuelve a pending con backoff, no se descarta: el operador prefiere
    // reimprimir de más que descubrir que faltó una comanda.
    expect(job.status).toBe('pending');
    expect(job.lastError).toContain('Sin papel');
  });

  it('reimprime creando un trabajo nuevo, para que el histórico lo registre', async () => {
    await post('/print/kitchen', { ...COMANDA, jobId: 'j-1' });
    await vi.waitFor(() => expect(queue.get('j-1')!.status).toBe('done'));

    const res = await post('/jobs/j-1/reprint', {});
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(jobId).not.toBe('j-1');

    await vi.waitFor(() => expect(impresora.recibido).toHaveLength(2));
    // El original sigue ahí: la reimpresión no borra la huella de la primera.
    expect(queue.get('j-1')).toBeDefined();
    expect(impresora.recibido[1]).toEqual(impresora.recibido[0]);
  });

  it('reimprimir un trabajo que ya no existe es 404, no un error del agente', async () => {
    const res = await post('/jobs/no-existe/reprint', {});
    expect(res.status).toBe(404);
  });

  it('/jobs lista el estado sin exponer los bytes del ticket', async () => {
    await post('/print/kitchen', { ...COMANDA, jobId: 'j-1' });
    const res = await fetch(`${base}/jobs`, {
      headers: { 'x-agent-token': TOKEN },
    });
    expect(res.status).toBe(200);
    const { jobs } = (await res.json()) as {
      jobs: Array<Record<string, unknown>>;
    };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'j-1',
      printer: 'cocina',
      kind: 'kitchen_ticket',
      reference: '#1042',
    });
    expect(jobs[0]).not.toHaveProperty('payloadBase64');
  });

  it('una ruta desconocida es 404', async () => {
    const res = await fetch(`${base}/imprimir`, {
      headers: { 'x-agent-token': TOKEN },
    });
    expect(res.status).toBe(404);
  });
});
