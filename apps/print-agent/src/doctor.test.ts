import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, formatDoctor, doctorOk } from './doctor.js';

/**
 * El diagnóstico existe porque «el servicio arrancó» no prueba nada: el agente
 * arranca igual con la impresora apagada, el disco lleno y el puerto ocupado.
 * Los tres fallan más tarde, en hora punta y con una comanda dentro.
 */

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doctor-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entorno = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  AGENT_TOKEN: 'token-de-emparejamiento-largo',
  PRINTERS: `cocina=file:${join(dir, 'cocina.bin')}`,
  QUEUE_FILE: join(dir, 'cola.json'),
  AGENT_PORT: '7461',
  ...extra,
});

const buscar = (r: Awaited<ReturnType<typeof runDoctor>>, nombre: string) =>
  r.find((x) => x.name.startsWith(nombre))!;

describe('Diagnóstico del agente', () => {
  it('con todo bien da luz verde', async () => {
    const r = await runDoctor(entorno());
    expect(doctorOk(r)).toBe(true);
    expect(buscar(r, 'Cola en disco').status).toBe('ok');
    expect(formatDoctor(r)).toContain('Todo correcto');
  });

  it('una configuración inválida corta el diagnóstico ahí mismo', async () => {
    // Seguir daría una lista de errores derivados que esconden el único que
    // importa: sin configuración no hay nada más que comprobar.
    const r = await runDoctor(entorno({ AGENT_TOKEN: 'corto' }));
    expect(doctorOk(r)).toBe(false);
    expect(buscar(r, 'Configuración').detail).toMatch(/16 caracteres/);
    expect(r.some((x) => x.name.startsWith('Impresora'))).toBe(false);
  });

  it('una cola no escribible es FALLA, no aviso', async () => {
    // Si esto pasa, el agente arranca igual y pierde TODOS los trabajos al
    // primer reinicio, que es justo cuando más falta hacen.
    // Se cuelga la cola de un fichero en vez de una carpeta (ENOTDIR). Un
    // `chmod` no serviría: el agente suele instalarse corriendo como root, y
    // root se salta los permisos — la prueba pasaría sin comprobar nada.
    const estorbo = join(dir, 'esto-es-un-fichero');
    await writeFile(estorbo, 'x', 'utf8');
    const r = await runDoctor(
      entorno({ QUEUE_FILE: join(estorbo, 'cola.json') }),
    );
    const cola = buscar(r, 'Cola en disco');
    expect(cola.status).toBe('fail');
    expect(cola.detail).toMatch(/reinicio|pendientes/);
    expect(doctorOk(r)).toBe(false);
  });

  it('una impresora apagada es AVISO y no impide instalar', async () => {
    // Puede estar apagada mientras se instala, y los trabajos esperarán en la
    // cola sin perderse. Fallar aquí deja al instalador atascado esperando a
    // que alguien traiga el cable.
    const r = await runDoctor(
      entorno({ PRINTERS: 'cocina=net:192.0.2.1:9100' }), // TEST-NET-1: no existe
    );
    const impresora = buscar(r, 'Impresora');
    expect(impresora.status).toBe('warn');
    expect(impresora.detail).toMatch(/encendida/);
    expect(doctorOk(r)).toBe(true);
    expect(formatDoctor(r)).toContain('puede arrancar');
  });

  it('avisa si el puerto está ocupado, sin confundirlo con una avería', async () => {
    let servidor: Server | undefined;
    try {
      servidor = createServer();
      await new Promise<void>((res) =>
        servidor!.listen(7462, '127.0.0.1', res),
      );

      const r = await runDoctor(entorno({ AGENT_PORT: '7462' }));
      const puerto = buscar(r, 'Puerto');
      expect(puerto.status).toBe('warn');
      // El caso normal es que el propio agente ya esté corriendo.
      expect(puerto.detail).toMatch(/ya está corriendo/);
    } finally {
      await new Promise<void>((res) => servidor?.close(() => res()));
    }
  });

  it('el resumen cuenta los problemas y dice qué hacer', async () => {
    const r = await runDoctor(entorno({ AGENT_TOKEN: '' }));
    const texto = formatDoctor(r);
    expect(texto).toMatch(/1 problema\(s\) que impiden funcionar/);
    expect(texto).toMatch(/vuelve a ejecutar el diagnóstico/);
  });
});
