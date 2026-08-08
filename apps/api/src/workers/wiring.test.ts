import { readFile } from 'node:fs/promises';
import { describe, it, expect, beforeAll } from 'vitest';

/**
 * El worker está CABLEADO: cada barrido existe y además se arranca.
 *
 * Esta prueba nace de un fallo real encontrado en T4.30. `IngestionService`
 * tenía `processPending` desde F4, con sus pruebas en verde... y nadie lo
 * llamaba en producción. Los webhooks de marketplace se aceptaban con 202, se
 * guardaban en `int_webhook_events` con status 'pending' y ahí se quedaban para
 * siempre: un pedido de Rappi habría entrado, el proveedor lo habría dado por
 * recibido, y no habría llegado nunca a la cocina.
 *
 * Ninguna prueba lo detectó porque todas llamaban a `processPending` a mano. El
 * hueco no estaba en el servicio, estaba en el ARRANQUE, y el arranque es
 * justamente lo que casi nunca se prueba: es un guion con `void bootstrap()`
 * que abre Redis, Postgres y OTel.
 *
 * Se comprueba leyendo el fuente. Es tosco, sí, pero cuesta milisegundos, no
 * necesita infraestructura y responde a la única pregunta que importa: si un
 * módulo nuevo trae un barrido, ¿alguien lo arranca? Un `PeriodicJob` declarado
 * y sin `start()` es trabajo que no ocurre nunca, y desde fuera se parece
 * demasiado a que no haya trabajo pendiente.
 */

const RUTA = new URL('./main.ts', import.meta.url);

/** Barridos que el worker DEBE arrancar, con el método que ejecuta cada uno. */
const BARRIDOS = [
  { job: 'outbox-relay', metodo: 'relayOnce(' },
  { job: 'acceptance-sweep', metodo: 'sweepAllTenants(' },
  { job: 'billing-queue', metodo: 'processQueueAllTenants(' },
  { job: 'ingestion-sweep', metodo: 'processPending(' },
];

describe('cableado del worker', () => {
  let fuente = '';

  beforeAll(async () => {
    fuente = await readFile(RUTA, 'utf8');
  });

  it.each(BARRIDOS)('declara el barrido "$job"', ({ job, metodo }) => {
    expect(fuente).toContain(`name: '${job}'`);
    expect(fuente).toContain(metodo);
  });

  /**
   * Declarar el trabajo no basta: sin `start()` el `PeriodicJob` es un objeto
   * inerte, y el sistema se comporta como si no hubiera nada que hacer.
   */
  it('arranca todos los trabajos que declara', () => {
    const declarados = [...fuente.matchAll(/const (\w+) = new PeriodicJob\(/g)]
      .map((m) => m[1])
      .filter((n): n is string => n !== undefined);

    expect(declarados).toHaveLength(BARRIDOS.length);
    for (const nombre of declarados) {
      expect(fuente).toContain(`${nombre}.start()`);
      // Y se paran al apagar: un barrido que sigue vivo mientras se cierran el
      // pool y Redis aborta su transacción en cada despliegue.
      expect(fuente).toContain(`${nombre}.stop()`);
    }
  });
});
