import { describe, it, expect, vi } from 'vitest';
import { PeriodicJob } from './periodic-job.js';

/**
 * El bucle del worker se prueba con un `sleep` inyectado, no con
 * temporizadores reales: una prueba que espera segundos no se ejecuta en cada
 * commit, y esto decide si los eventos salen del outbox.
 */

/** `sleep` que resuelve al instante y cuenta las esperas pedidas. */
function sleepInstantaneo(): {
  sleep: (ms: number) => Promise<void>;
  esperas: number[];
} {
  const esperas: number[] = [];
  return {
    esperas,
    sleep: async (ms: number) => {
      esperas.push(ms);
      await Promise.resolve();
    },
  };
}

describe('PeriodicJob', () => {
  it('ejecuta el trabajo en cada vuelta', async () => {
    let vueltas = 0;
    const job = new PeriodicJob({
      name: 'prueba',
      intervalMs: 10,
      run: async () => {
        vueltas++;
      },
    });

    await job.runOnce();
    await job.runOnce();
    expect(vueltas).toBe(2);
  });

  it('NO solapa vueltas: si una sigue viva, la siguiente se omite', async () => {
    // Es la protección que evita que un barrido lento acumule ejecuciones
    // concurrentes hasta agotar el pool de conexiones.
    let enCurso = 0;
    let maximoSimultaneo = 0;
    let resolver!: () => void;
    const bloqueada = new Promise<void>((r) => {
      resolver = r;
    });

    const job = new PeriodicJob({
      name: 'lenta',
      intervalMs: 1,
      run: async () => {
        enCurso++;
        maximoSimultaneo = Math.max(maximoSimultaneo, enCurso);
        await bloqueada;
        enCurso--;
      },
    });

    const primera = job.runOnce();
    // La segunda llega mientras la primera sigue bloqueada.
    await job.runOnce();
    resolver();
    await primera;

    expect(
      maximoSimultaneo,
      'dos vueltas corrieron a la vez: el worker se comería el pool',
    ).toBe(1);
  });

  it('un fallo NO detiene el bucle: la siguiente vuelta ocurre igual', async () => {
    // Un worker que muere al primer fallo transitorio deja de publicar eventos
    // y nadie se entera hasta que la cocina pregunta.
    let intentos = 0;
    const job = new PeriodicJob({
      name: 'inestable',
      intervalMs: 1,
      run: async () => {
        intentos++;
        if (intentos === 1) throw new Error('fallo transitorio de red');
      },
    });

    await expect(job.runOnce()).resolves.toBeUndefined();
    await job.runOnce();
    expect(intentos).toBe(2);
  });

  it('el bucle respeta el intervalo entre vueltas', async () => {
    const { sleep, esperas } = sleepInstantaneo();
    let vueltas = 0;
    const job = new PeriodicJob({
      name: 'bucle',
      intervalMs: 250,
      initialDelayMs: 40,
      sleep,
      run: async () => {
        vueltas++;
        if (vueltas >= 3) await job.stop();
      },
    });

    job.start();
    // Se cede el control lo suficiente para que el bucle avance sus vueltas.
    for (let i = 0; i < 50; i++) await Promise.resolve();

    expect(vueltas).toBeGreaterThanOrEqual(3);
    expect(esperas[0], 'no respetó el retraso inicial').toBe(40);
    expect(esperas.slice(1).every((e) => e === 250)).toBe(true);
  });

  it('stop() espera a que la vuelta en curso termine', async () => {
    // En un despliegue, matar el proceso a mitad de una transición deja
    // trabajo a medias. `stop()` existe para que eso no pase.
    let terminada = false;
    let resolver!: () => void;
    const bloqueada = new Promise<void>((r) => {
      resolver = r;
    });

    const job = new PeriodicJob({
      name: 'apagado',
      intervalMs: 1,
      sleep: async () => undefined,
      run: async () => {
        await bloqueada;
        terminada = true;
      },
    });

    job.start();
    await Promise.resolve();
    const parada = job.stop();
    expect(terminada).toBe(false);

    resolver();
    await parada;
    expect(terminada, 'stop() volvió antes de que la vuelta terminara').toBe(
      true,
    );
  });

  it('start() dos veces no crea dos bucles', async () => {
    const { sleep } = sleepInstantaneo();
    let vueltas = 0;
    const job = new PeriodicJob({
      name: 'doble-arranque',
      intervalMs: 1,
      sleep,
      run: async () => {
        vueltas++;
        if (vueltas >= 2) await job.stop();
      },
    });

    job.start();
    job.start();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // Con dos bucles vivos las vueltas se dispararían muy por encima del corte.
    expect(vueltas).toBeLessThanOrEqual(3);
  });

  it('expone si hay una vuelta en curso', async () => {
    let resolver!: () => void;
    const bloqueada = new Promise<void>((r) => {
      resolver = r;
    });
    const job = new PeriodicJob({
      name: 'estado',
      intervalMs: 1,
      run: () => bloqueada,
    });

    expect(job.isRunning).toBe(false);
    const vuelta = job.runOnce();
    expect(job.isRunning).toBe(true);
    resolver();
    await vuelta;
    expect(job.isRunning).toBe(false);
  });

  it('registra el fallo sin propagarlo', async () => {
    const job = new PeriodicJob({
      name: 'silencioso',
      intervalMs: 1,
      run: async () => {
        throw new Error('boom');
      },
    });
    // No propaga: si lo hiciera, el bucle moriría con la primera excepción.
    await expect(job.runOnce()).resolves.toBeUndefined();
  });

  it('tolera un valor lanzado que no es Error', async () => {
    const job = new PeriodicJob({
      name: 'raro',
      intervalMs: 1,
      run: async () => {
        // Un valor lanzado que no es Error: ocurre de verdad con librerías
        // antiguas, y el registro del fallo no puede reventar por ello.
        return Promise.reject('cadena suelta');
      },
    });
    await expect(job.runOnce()).resolves.toBeUndefined();
  });
});

describe('PeriodicJob — instrumentación', () => {
  it('cuenta las vueltas correctas y las fallidas por separado', async () => {
    const { registry } = await import('../observability/metrics.js');
    const job = new PeriodicJob({
      name: 'metricas-prueba',
      intervalMs: 1,
      run: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('fallo')),
    });

    await job.runOnce();
    await job.runOnce();

    const texto = await registry.metrics();
    expect(texto).toMatch(
      /sahana_worker_runs_total\{[^}]*job="metricas-prueba"[^}]*result="ok"[^}]*\} 1/,
    );
    expect(texto).toMatch(
      /sahana_worker_runs_total\{[^}]*job="metricas-prueba"[^}]*result="error"[^}]*\} 1/,
    );
  });
});
