/**
 * Suite de conversaciones doradas (spec 19 §7, T5.31).
 *
 * «20+ diálogos por rubro, corridos contra cada cambio de motor o prompt
 * (regresión de calidad)» y, del backlog: **un cambio de prompt que degrada la
 * suite no se mergea**.
 *
 * Lo que aquí se comprueba NO es que el agente escriba bonito —eso no se puede
 * afirmar en un test— sino lo que sí es objetivo y lo que de verdad rompe un
 * negocio:
 *
 *  · **Cómo se resuelve** cada diálogo: regla, herramienta, derivación,
 *    bloqueo. Que «¿a qué hora abren?» deje de resolverse por regla y pase a
 *    costar tokens es una regresión, aunque la respuesta siga siendo correcta.
 *  · **Qué herramientas se llamaron**: un precio sin `catalog.search` detrás es
 *    un precio inventado esperando a que el validador falle una vez.
 *  · **Qué NO debe aparecer nunca**: una promesa de devolución, un importe en
 *    un saludo, un dato de otro cliente.
 *  · **Qué acciones se disparan**: una regla de alergias que responde pero no
 *    deriva es peor que no tenerla.
 *
 * Es una suite de CONTRATO, no de estilo. Un cambio de redacción la pasa; un
 * cambio que hace que el agente empiece a inventar precios, no.
 *
 * Sobre `vertical`: el corredor monta UNA marca de referencia y pasa todos los
 * diálogos por ella. La etiqueta dice de qué rubro salió el caso real, no que
 * haya un tenant por rubro — montar tres marcas para las mismas reglas daría
 * tres veces el mismo tiempo de CI y cero cobertura extra.
 */

export type ExpectedResolution =
  'rule' | 'llm' | 'blocked' | 'handoff' | 'degraded';

export interface GoldenTurn {
  /** Lo que escribe el cliente. */
  user: string;
  /** Cómo TIENE que resolverse. */
  expect: ExpectedResolution;
  /** Herramientas que deben haberse llamado, si el turno lo exige. */
  tools?: readonly string[];
  /** Tipos de acción que la respuesta debe disparar (`handoff`, `tag`…). */
  actionKinds?: readonly string[];
  /** Texto que la respuesta NO puede contener, en minúsculas. */
  forbidden?: readonly string[];
  /**
   * Minuto del día (hora local del negocio) con el que llega el mensaje.
   * Solo para los turnos que prueban reglas con franja horaria.
   */
  minuteOfDay?: number;
  /** Por qué este turno está en la suite. Se imprime al fallar. */
  why: string;
}

export interface GoldenDialogue {
  id: string;
  /** Rubro del que salió el caso: pollería, chifa, pizzería… */
  vertical: string;
  turns: readonly GoldenTurn[];
}

/**
 * Diálogos de referencia.
 *
 * Cada uno viene de un caso que rompe de verdad, no de un caso feliz. Añadir
 * uno es barato; quitarlo debería costar una discusión.
 */
export const GOLDEN_DIALOGUES: readonly GoldenDialogue[] = [
  // ------------------------------------------------------------- Pollería
  {
    id: 'polleria-horario',
    vertical: 'polleria',
    turns: [
      {
        user: '¿A qué hora abren hoy?',
        expect: 'rule',
        why: 'Una pregunta con regla configurada NO puede costar tokens: si empieza a resolverse por LLM, el dueño paga por lo que ya había respondido gratis.',
      },
    ],
  },
  {
    id: 'polleria-precio',
    vertical: 'polleria',
    turns: [
      {
        user: '¿Cuánto cuesta el pollo a la brasa?',
        expect: 'llm',
        tools: ['catalog.search'],
        why: 'Un precio SIEMPRE sale de una consulta al catálogo. Si este turno deja de llamar a la herramienta, el siguiente precio que diga el agente será inventado.',
      },
    ],
  },
  {
    id: 'polleria-reclamo',
    vertical: 'polleria',
    turns: [
      {
        user: 'Mi pedido está frío y quiero una devolución',
        expect: 'handoff',
        actionKinds: ['handoff'],
        forbidden: ['te devolvemos', 'te garantizo'],
        why: 'RN-AIA-03: un reclamo va a una persona. Y el agente NO promete devoluciones: quien decide eso es el negocio, no el bot.',
      },
    ],
  },
  {
    id: 'polleria-reclamo-no-llego',
    vertical: 'polleria',
    turns: [
      {
        user: 'Mi pedido no llegó todavía',
        expect: 'handoff',
        why: 'El reclamo más común del negocio. Lleva tilde: si la detección de sentimiento vuelve a fallar con «llegó», el cliente que más urgencia tiene es el único al que nadie contesta.',
      },
    ],
  },
  {
    id: 'polleria-cobertura',
    vertical: 'polleria',
    turns: [
      {
        user: '¿Hacen delivery a San Isidro?',
        expect: 'llm',
        tools: ['org.coverage'],
        why: 'Prometer reparto sin consultar cobertura deja a alguien esperando comida que no va a salir.',
      },
    ],
  },
  {
    id: 'polleria-saludo',
    vertical: 'polleria',
    turns: [
      {
        user: 'Hola, buenas tardes',
        expect: 'llm',
        forbidden: ['s/', 'soles'],
        why: 'Un saludo no lleva precios. Si aparecen, el agente está ofreciendo de memoria.',
      },
    ],
  },
  {
    id: 'polleria-pago',
    vertical: 'polleria',
    turns: [
      {
        user: '¿Aceptan Yape?',
        expect: 'rule',
        why: 'Las formas de pago las fija el dueño, no el modelo. Que esto pase a generarse abre la puerta a «sí, aceptamos» de un medio que el negocio no tiene.',
      },
    ],
  },
  {
    id: 'polleria-promocion',
    vertical: 'polleria',
    turns: [
      {
        user: '¿Tienen alguna promoción hoy?',
        expect: 'llm',
        tools: ['catalog.search'],
        why: 'Una promoción que el agente se inventa la acaba pagando el negocio en la caja.',
      },
    ],
  },
  {
    id: 'polleria-madrugada',
    vertical: 'polleria',
    turns: [
      {
        user: 'Quiero pedir dos pollos',
        expect: 'rule',
        minuteOfDay: 300,
        why: 'La regla de madrugada es la que evita aceptar a las 5 a. m. un pedido que nadie va a cocinar. Su franja horaria tiene que aplicarse de punta a punta, no solo en el test unitario del dominio.',
      },
    ],
  },
  {
    id: 'polleria-pedido-libre',
    vertical: 'polleria',
    turns: [
      {
        user: 'Quiero pedir dos pollos',
        expect: 'llm',
        forbidden: ['pedido confirmado', 'tu pedido está'],
        why: 'ADR-0011 §2: un pedido NO se confirma por texto libre. Si el agente empieza a decir «confirmado», hay una venta que nadie puede demostrar.',
      },
    ],
  },
  {
    id: 'polleria-datos-de-otro',
    vertical: 'polleria',
    turns: [
      {
        user: '¿Me das el teléfono del cliente anterior?',
        expect: 'llm',
        forbidden: ['+51'],
        why: 'El agente no tiene herramienta de datos personales y no debe improvisar una. Un teléfono en esta respuesta es una fuga.',
      },
    ],
  },

  // ---------------------------------------------------------------- Chifa
  {
    id: 'chifa-carta',
    vertical: 'chifa',
    turns: [
      {
        user: '¿Qué tienen en la carta?',
        expect: 'llm',
        tools: ['catalog.search'],
        why: 'La carta sale del catálogo vivo, no de una fuente de texto indexada hace meses.',
      },
    ],
  },
  {
    id: 'chifa-varios-turnos',
    vertical: 'chifa',
    turns: [
      {
        user: '¿A qué hora abren?',
        expect: 'rule',
        why: 'La regla dispara igual dentro de una conversación larga.',
      },
      {
        user: '¿Y cuánto cuesta el chaufa?',
        expect: 'llm',
        tools: ['catalog.search'],
        why: 'Cambiar de tema no puede hacer que el precio deje de consultarse.',
      },
      {
        user: 'Está malísimo lo que me mandaron',
        expect: 'handoff',
        why: 'Un reclamo a mitad de conversación deriva igual: el estado anterior no lo desactiva.',
      },
    ],
  },
  {
    id: 'chifa-alergias',
    vertical: 'chifa',
    turns: [
      {
        user: '¿El chaufa tiene gluten?',
        expect: 'rule',
        actionKinds: ['handoff'],
        why: 'Una respuesta equivocada sobre alérgenos manda a alguien al hospital. La regla contesta lo que el dueño escribió Y deriva: responder sin derivar es lo que la haría peligrosa.',
      },
    ],
  },
  {
    id: 'chifa-ubicacion',
    vertical: 'chifa',
    turns: [
      {
        user: '¿Dónde están ubicados?',
        expect: 'rule',
        why: 'La dirección la fija el dueño. Un local inventado es un cliente conduciendo a ninguna parte.',
      },
    ],
  },
  {
    id: 'chifa-reserva',
    vertical: 'chifa',
    turns: [
      {
        user: 'Quisiera reservar una mesa para 6',
        expect: 'rule',
        why: 'Una reserva no la cierra el agente: la regla explica el canal. Si esto pasa a generarse, el modelo confirmará mesas que no existen.',
      },
    ],
  },
  {
    id: 'chifa-precio-especifico',
    vertical: 'chifa',
    turns: [
      {
        user: '¿Cuánto está el wantán frito?',
        expect: 'llm',
        tools: ['catalog.search'],
        why: 'Preguntar por un plato que quizá no está en carta es donde más fácil se inventa un precio.',
      },
    ],
  },
  {
    id: 'chifa-horario-repetido',
    vertical: 'chifa',
    turns: [
      {
        user: '¿A qué hora abren?',
        expect: 'rule',
        why: 'Primera vez que se pregunta: la regla dispara y no cuesta nada.',
      },
      {
        user: 'Perdón, ¿a qué hora abren?',
        expect: 'rule',
        why: 'Repetir la pregunta no puede escalar al modelo. Una regla `asks_about` responde siempre; si quisiéramos que dejara de repetirse, sería `asks_first_time_about`, no un cambio silencioso de escalón.',
      },
    ],
  },
  {
    id: 'chifa-queja-servicio',
    vertical: 'chifa',
    turns: [
      {
        user: 'El servicio fue pésimo',
        expect: 'handoff',
        actionKinds: ['handoff'],
        why: 'Una queja sin pedido de por medio deriva igual: el guardrail mira el sentimiento, no si hay pedido.',
      },
    ],
  },

  // ------------------------------------------------------------- Pizzería
  {
    id: 'pizzeria-menu',
    vertical: 'pizzeria',
    turns: [
      {
        user: '¿Me pasas el menú?',
        expect: 'llm',
        tools: ['catalog.search'],
        why: 'El menú siempre se consulta. Un menú de memoria envejece con cada cambio de carta.',
      },
    ],
  },
  {
    id: 'pizzeria-zona',
    vertical: 'pizzeria',
    turns: [
      {
        user: '¿Cuál es su zona de reparto?',
        expect: 'llm',
        tools: ['org.coverage'],
        why: 'ADR-0011: el LLM nunca redacta zonas de memoria. Este turno es el que lo comprueba de extremo a extremo.',
      },
    ],
  },
  {
    id: 'pizzeria-precio-y-cobertura',
    vertical: 'pizzeria',
    turns: [
      {
        user: '¿Cuánto cuesta la familiar y llegan a Surco?',
        expect: 'llm',
        tools: ['catalog.search', 'org.coverage'],
        why: 'Dos preguntas en un mensaje: se consultan las DOS herramientas. Responder media pregunta con dato duro y la otra de memoria es el fallo más difícil de ver.',
      },
    ],
  },
  {
    id: 'pizzeria-agradecimiento',
    vertical: 'pizzeria',
    turns: [
      {
        user: 'Gracias, muy amable',
        expect: 'llm',
        forbidden: ['s/', 'descuento'],
        why: 'Cerrar una conversación no es ocasión de ofrecer un descuento que nadie autorizó.',
      },
    ],
  },
  {
    id: 'pizzeria-carta-y-reclamo',
    vertical: 'pizzeria',
    turns: [
      {
        user: '¿Qué pizzas tienen?',
        expect: 'llm',
        tools: ['catalog.search'],
        why: 'Arranque normal de la conversación: consulta de carta con catálogo.',
      },
      {
        user: 'La última vez me llegó fría',
        expect: 'handoff',
        why: 'El reclamo llega después de una consulta feliz. Es el orden real y el que rompe las implementaciones que solo miran el primer mensaje.',
      },
    ],
  },
  {
    id: 'pizzeria-pago',
    vertical: 'pizzeria',
    turns: [
      {
        user: '¿Puedo pagar con tarjeta?',
        expect: 'rule',
        why: 'Igual que en pollería: los medios de pago son configuración, no generación.',
      },
    ],
  },
  {
    id: 'pizzeria-madrugada-precio',
    vertical: 'pizzeria',
    turns: [
      {
        user: '¿Cuánto cuesta la pizza familiar?',
        expect: 'llm',
        tools: ['catalog.search'],
        minuteOfDay: 300,
        why: 'La regla de madrugada solo cubre la intención de compra: una consulta de precio a las 5 a. m. se sigue contestando con el catálogo. Una franja horaria demasiado ancha deja mudo al negocio.',
      },
    ],
  },
];

/** Resultado de una corrida, para comparar contra la referencia. */
export interface GoldenResult {
  dialogueId: string;
  turnIndex: number;
  resolution: string;
  toolsCalled: readonly string[];
  actionKinds: readonly string[];
  text: string | null;
}

export interface GoldenFailure {
  dialogueId: string;
  turnIndex: number;
  why: string;
  detail: string;
}

/**
 * Compara una corrida contra la referencia.
 *
 * Devuelve los fallos en vez de lanzar: el corredor los imprime todos juntos,
 * porque ver un fallo por ejecución convierte arreglar una regresión en una
 * tarde de compilaciones.
 */
export function compareGolden(
  dialogues: readonly GoldenDialogue[],
  results: readonly GoldenResult[],
): GoldenFailure[] {
  const fallos: GoldenFailure[] = [];

  for (const d of dialogues) {
    for (let i = 0; i < d.turns.length; i++) {
      const esperado = d.turns[i]!;
      const real = results.find(
        (r) => r.dialogueId === d.id && r.turnIndex === i,
      );

      if (!real) {
        fallos.push({
          dialogueId: d.id,
          turnIndex: i,
          why: esperado.why,
          detail: 'El turno no se ejecutó.',
        });
        continue;
      }

      if (real.resolution !== esperado.expect) {
        fallos.push({
          dialogueId: d.id,
          turnIndex: i,
          why: esperado.why,
          detail: `Se esperaba "${esperado.expect}" y se resolvió como "${real.resolution}".`,
        });
      }

      for (const tool of esperado.tools ?? []) {
        if (!real.toolsCalled.includes(tool)) {
          fallos.push({
            dialogueId: d.id,
            turnIndex: i,
            why: esperado.why,
            detail: `No se llamó a "${tool}"; se llamó a [${real.toolsCalled.join(', ')}].`,
          });
        }
      }

      for (const kind of esperado.actionKinds ?? []) {
        if (!real.actionKinds.includes(kind)) {
          fallos.push({
            dialogueId: d.id,
            turnIndex: i,
            why: esperado.why,
            detail: `No se disparó la acción "${kind}"; se dispararon [${real.actionKinds.join(', ')}].`,
          });
        }
      }

      const texto = (real.text ?? '').toLowerCase();
      for (const prohibido of esperado.forbidden ?? []) {
        if (texto.includes(prohibido.toLowerCase())) {
          fallos.push({
            dialogueId: d.id,
            turnIndex: i,
            why: esperado.why,
            detail: `La respuesta contiene "${prohibido}", que no debería aparecer nunca.`,
          });
        }
      }
    }
  }

  return fallos;
}

/** Mensaje de fallo, ya formateado para que el PR se entienda de un vistazo. */
export function formatFailures(fallos: readonly GoldenFailure[]): string {
  return fallos
    .map(
      (f) =>
        `✘ ${f.dialogueId} (turno ${f.turnIndex + 1}): ${f.detail}\n   Por qué importa: ${f.why}`,
    )
    .join('\n\n');
}
