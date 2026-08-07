import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { scanForPrinters, localPrefixes } from './scan.js';

/**
 * El asistente pregunta «¿dónde está la impresora?» y la respuesta honesta de
 * quien monta el local es «no sé»: la IP de una térmica no está escrita en
 * ninguna parte. Escanear y ofrecer una lista es la diferencia entre cinco
 * minutos y una llamada a soporte.
 */

const abiertos: Server[] = [];
afterEach(async () => {
  await Promise.all(
    abiertos.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

async function escuchar(port: number): Promise<void> {
  const s = createServer();
  abiertos.push(s);
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', r));
}

describe('Descubrimiento de impresoras', () => {
  it('encuentra lo que responde en el puerto de la impresora', async () => {
    await escuchar(9401);
    const halladas = await scanForPrinters({
      prefix: '127.0.0',
      port: 9401,
      from: 1,
      to: 1,
    });
    expect(halladas).toEqual([{ host: '127.0.0.1', port: 9401 }]);
  });

  it('no inventa impresoras donde no hay nada', async () => {
    const halladas = await scanForPrinters({
      prefix: '127.0.0',
      port: 9402,
      from: 1,
      to: 1,
      timeoutMs: 100,
    });
    expect(halladas).toEqual([]);
  });

  it('un rango entero termina en tiempo razonable sin agotar sockets', async () => {
    // Sin tope de concurrencia, 254 sockets a la vez agotan los descriptores
    // de una mini PC modesta —el hardware recomendado— y el escaneo devuelve
    // falsos negativos: la impresora está, pero no quedaban sockets.
    await escuchar(9403);
    const inicio = Date.now();
    const halladas = await scanForPrinters({
      prefix: '127.0.0',
      port: 9403,
      timeoutMs: 100,
      concurrency: 16,
    });
    expect(Date.now() - inicio).toBeLessThan(10_000);
    expect(halladas.map((h) => h.host)).toContain('127.0.0.1');
  });

  it('devuelve la lista ordenada para que no baile entre escaneos', async () => {
    await escuchar(9404);
    const a = await scanForPrinters({ prefix: '127.0.0', port: 9404, to: 3 });
    const b = await scanForPrinters({ prefix: '127.0.0', port: 9404, to: 3 });
    expect(a).toEqual(b);
  });

  it('ignora loopback y las interfaces internas al proponer redes', () => {
    // Escanear 127.0.0.x no encuentra impresoras, y una mini PC suele traer
    // interfaces virtuales de Docker o del VPN que no llevan a ninguna parte.
    const prefijos = localPrefixes({
      lo: [
        {
          address: '127.0.0.1',
          family: 'IPv4',
          internal: true,
        } as never,
      ],
      eth0: [
        {
          address: '192.168.1.23',
          family: 'IPv4',
          internal: false,
        } as never,
        {
          address: 'fe80::1',
          family: 'IPv6',
          internal: false,
        } as never,
      ],
    });
    expect(prefijos).toEqual(['192.168.1']);
  });
});
