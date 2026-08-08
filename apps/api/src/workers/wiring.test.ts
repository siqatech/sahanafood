import { readFile, readdir } from 'node:fs/promises';
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
const MODULOS = new URL('../modules/', import.meta.url);

/** Barridos que el worker DEBE arrancar, con el método que ejecuta cada uno. */
const BARRIDOS = [
  { job: 'outbox-relay', metodo: 'relayOnce(' },
  { job: 'acceptance-sweep', metodo: 'sweepAllTenants(' },
  { job: 'billing-queue', metodo: 'processQueueAllTenants(' },
  { job: 'ingestion-sweep', metodo: 'processPending(' },
  { job: 'payments-refunds', metodo: 'processRefunds(' },
  { job: 'kitchen-saturation', metodo: 'saturation.sweep(' },
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

  /**
   * Y lo mismo para los CONSUMIDORES de eventos.
   *
   * Esta parte nace de un fallo de la misma familia, encontrado en T5.32 y
   * peor: `AiEventHandlers` no existía, así que
   * `conversation.message_received` se publicaba y no lo escuchaba nadie. La
   * plataforma entera del agente —reglas, herramientas, RAG, validador,
   * presupuesto, suite dorada— estaba construida, probada y era **inalcanzable
   * desde fuera**: la única ruta que llamaba al agente era el sandbox del
   * dueño. Un cliente escribiendo por WhatsApp no recibía nada.
   *
   * La comprobación anterior solo miraba los `PeriodicJob`. Un módulo puede
   * traer trabajo de fondo de dos formas —barrido o consumidor— y solo una
   * estaba vigilada.
   */
  it('registra en el worker TODO módulo que declare handlers de eventos', async () => {
    const modulos = await readdir(MODULOS, { withFileTypes: true });
    const conHandlers: string[] = [];

    for (const m of modulos) {
      if (!m.isDirectory()) continue;
      const publico = new URL(`./${m.name}/index.ts`, MODULOS);
      const contenido = await readFile(publico, 'utf8').catch(() => '');
      // La convención del proyecto: quien consume eventos exporta su nombre de
      // consumidor por su API pública.
      const consumidor = /export \{[^}]*?(\w+_CONSUMER)/s.exec(contenido);
      if (consumidor?.[1]) conHandlers.push(consumidor[1]);
    }

    // Si esto sale vacío, la convención cambió y la prueba dejó de comprobar
    // nada: mejor que falle a que apruebe en silencio.
    expect(conHandlers.length).toBeGreaterThan(3);

    for (const constante of conHandlers) {
      expect(
        fuente,
        `El módulo exporta ${constante} pero el worker no lo registra: sus eventos no los escucha nadie.`,
      ).toContain(`nombre: ${constante}`);
    }
  });
});
