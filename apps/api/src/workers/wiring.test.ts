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

/**
 * Y la tercera forma de que algo construido quede sin llamador: un EVENTO.
 *
 * Van seis veces en este proyecto. `processPending` sin barrido (T4.30), el
 * consumidor del agente que no existía (T5.32), `authenticateDevice` sin
 * endpoint, `paymentMethod` descartado en el borde, la venta del POS que nunca
 * llegaba a caja, y la mitad SALIENTE de las integraciones —`pushMenu`,
 * `setAvailability`, `updateOrderStatus`, `cancelAck`— implementada, probada
 * contra el simulador y sin un solo llamador en producción: se pausaba un plato
 * agotado y el marketplace seguía vendiéndolo.
 *
 * Las seis se encontraron a mano, leyendo. Esta prueba automatiza esa lectura:
 *
 *  · Todo evento que se PUBLICA o lo escucha alguien, o está en la lista de
 *    abajo con el motivo escrito. Añadir un evento sin consumidor y sin
 *    justificarlo rompe el build.
 *  · Todo evento que se ESCUCHA lo publica alguien. Un handler con el nombre
 *    mal escrito no falla nunca: simplemente no se ejecuta jamás.
 *
 * Los tipos publicados se sacan del fuente (no hay forma de ejecutar todas las
 * ramas); los escuchados, de llamar a `handlers()` de verdad, porque varios
 * módulos construyen sus claves con plantillas y una expresión regular se las
 * perdería.
 */

const SRC = new URL('../', import.meta.url);

/**
 * Eventos que hoy se publican y no escucha nadie, con el motivo.
 *
 * No es una lista de pendientes tolerados: es la frontera del sistema. La
 * mayoría son hechos que YA cambiaron el estado que el panel lee, y el evento
 * está para quien venga después. Las marcadas DT-13 son distintas: la spec pide
 * una ALERTA y no hay a quién mandarla todavía.
 */
const SIN_OYENTE: Record<string, string> = {
  'billing.deferral_alert':
    'DT-13 — RN-BIL-03 pide avisar antes del límite de antigüedad; sin destinatario aún.',
  'billing.document_accepted':
    'El estado del documento ya está en bil_documents, que es lo que lee el panel.',
  'billing.document_queued':
    'Igual que el anterior: la cola se ve en la tabla, no hace falta reaccionar.',
  'billing.document_rejected':
    'DT-13 — RN-BIL-02 pide alerta sobre la cola de corrección.',
  'cash.session_closed':
    'El arqueo cerrado se consulta; nadie tiene que reaccionar a él todavía.',
  'conversation.handoff_requested':
    'La derivación ya marcó handoff_at: la bandeja humana lo ve por estado.',
  'kitchen.recovered':
    'La saturación pausa y reanuda canales ella misma; el evento es traza.',
  'kitchen.saturated':
    'Idem: el efecto ya lo aplicó SaturationService en su transacción.',
  'kitchen.tickets_created':
    'Los tickets se consultan desde el KDS; nadie reacciona a su creación.',
  'order.acceptance_overdue':
    'DT-13 — RN-ORD-04 pide alerta al equipo; hoy solo queda acceptance_alerted_at.',
  'order.modified':
    'La modificación ya reescribió líneas y ticket dentro de su transacción.',
  'order.needs_review':
    'La bandeja de excepciones se consulta por estado (RN-ORD-10).',
  'order.scheduled':
    'El programado lo libera el barrido de aceptación por horario, no un evento.',
  'order.received':
    'Se acepta en el mismo flujo; cocina reacciona a order.accepted, no a este.',
  'payment.refunded':
    'El reembolso ya quedó registrado en pay_refunds; nada que disparar.',
};

/** Recorre `src` devolviendo solo fuente de producción. */
async function fuentesDeProduccion(dir: URL): Promise<string[]> {
  const entradas = await readdir(dir, { withFileTypes: true });
  const rutas: string[] = [];
  for (const e of entradas) {
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      rutas.push(...(await fuentesDeProduccion(new URL(`./${e.name}/`, dir))));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      rutas.push(new URL(`./${e.name}`, dir).pathname);
    }
  }
  return rutas;
}

interface Publicados {
  /** Tipos escritos tal cual: 'order.accepted'. */
  literales: Set<string>;
  /** Prefijos de plantilla: `order.${x}` deja 'order.'. */
  prefijos: Set<string>;
}

/**
 * Extrae los tipos de evento de las llamadas a `enqueueEvent`.
 *
 * Se ancla en `enqueueEvent(` a propósito y no en `eventType:` a secas: ese
 * nombre de campo también existe en `int_webhook_events`, que es un registro de
 * entrada y no un evento de dominio. Confundirlos metería 'order.created' —que
 * nadie publica— en la lista y el fallo parecería estar donde no está.
 */
function publicadosEn(fuente: string, acumulador: Publicados): void {
  for (const m of fuente.matchAll(/enqueueEvent\(/g)) {
    const trozo = fuente.slice(m.index, m.index + 900);
    const campo = /eventType:([\s\S]*?),\n/.exec(trozo);
    if (!campo?.[1]) continue;
    for (const lit of campo[1].matchAll(/'([a-z][a-z_]*\.[a-z][a-z_0-9]*)'/g)) {
      acumulador.literales.add(lit[1]!);
    }
    for (const tpl of campo[1].matchAll(/`([a-z][a-z_.]*\.[a-z_]*)\$\{/g)) {
      acumulador.prefijos.add(tpl[1]!);
    }
  }
}

describe('cableado de eventos', () => {
  const publicados: Publicados = {
    literales: new Set(),
    prefijos: new Set(),
  };
  const escuchados = new Set<string>();

  beforeAll(async () => {
    for (const ruta of await fuentesDeProduccion(SRC)) {
      publicadosEn(await readFile(ruta, 'utf8'), publicados);
    }

    const modulos = await readdir(MODULOS, { withFileTypes: true });
    for (const m of modulos) {
      if (!m.isDirectory()) continue;
      const publico = new URL(`./${m.name}/index.ts`, MODULOS);
      const contenido = await readFile(publico, 'utf8').catch(() => '');
      if (!/\w+_CONSUMER/.test(contenido)) continue;

      const modulo = (await import(publico.pathname)) as Record<
        string,
        unknown
      >;
      for (const [nombre, exportado] of Object.entries(modulo)) {
        if (!nombre.endsWith('EventHandlers')) continue;
        // Se instancia sin dependencias: `handlers()` solo construye el mapa;
        // los servicios se usan dentro de los cierres, que aquí no se llaman.
        const clase = exportado as new () => {
          handlers(): Record<string, unknown>;
        };
        for (const clave of Object.keys(new clase().handlers())) {
          escuchados.add(clave);
        }
      }
    }
  });

  it('la exploración encuentra algo (si no, dejó de comprobar nada)', () => {
    expect(publicados.literales.size).toBeGreaterThan(10);
    expect(escuchados.size).toBeGreaterThan(10);
  });

  it('todo evento PUBLICADO lo escucha alguien, o está justificado', () => {
    const huerfanos = [...publicados.literales]
      .filter((tipo) => !escuchados.has(tipo))
      .filter((tipo) => !(tipo in SIN_OYENTE));

    expect(
      huerfanos,
      `Estos eventos se publican y no los escucha nadie. O añade el consumidor, ` +
        `o apúntalos en SIN_OYENTE explicando por qué no hace falta:\n  ` +
        huerfanos.join('\n  '),
    ).toEqual([]);
  });

  it('todo evento ESCUCHADO lo publica alguien', () => {
    // Un handler con el nombre mal escrito no da error: no se ejecuta y ya.
    const sinEmisor = [...escuchados].filter(
      (tipo) =>
        !publicados.literales.has(tipo) &&
        ![...publicados.prefijos].some((p) => tipo.startsWith(p)),
    );

    expect(
      sinEmisor,
      `Hay handlers para eventos que nadie publica (¿nombre mal escrito?):\n  ` +
        sinEmisor.join('\n  '),
    ).toEqual([]);
  });

  it('la lista SIN_OYENTE no acumula entradas muertas', () => {
    // Si un evento deja de publicarse o alguien le pone consumidor, su excusa
    // sobra. Sin esto la lista crece y deja de significar nada.
    const obsoletas = Object.keys(SIN_OYENTE).filter(
      (tipo) => !publicados.literales.has(tipo) || escuchados.has(tipo),
    );
    expect(
      obsoletas,
      `Sobran en SIN_OYENTE (ya no se publican, o ya tienen consumidor):\n  ` +
        obsoletas.join('\n  '),
    ).toEqual([]);
  });
});
