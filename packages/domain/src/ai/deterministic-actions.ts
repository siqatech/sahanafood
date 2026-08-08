/**
 * Acciones deterministas del agente (spec 19 §2.3, ADR-0011 §1, T5.25).
 *
 * **Ganan SIEMPRE al LLM**, y con coste cero. Es el primer escalón de la
 * jerarquía de ADR-0011 y el que hace que este agente sea vendible: el dueño
 * configura «cuando pregunten por el horario, responde exactamente esto», y eso
 * se responde exactamente así, siempre, sin modelo de por medio y sin
 * posibilidad de que se invente nada.
 *
 * También es lo que sostiene la degradación por presupuesto (T5.30): cuando se
 * acaban los créditos, el negocio NO se queda mudo — sigue respondiendo con
 * estas reglas. Un agente que se cae cuando se acaba el saldo es peor que no
 * tener agente, porque el cliente ya está esperando.
 *
 * Puro y sin I/O: se prueba con casos concretos, que es lo que permite discutir
 * con el dueño por qué su regla no disparó.
 */

export type ConditionKind =
  /** El mensaje trata de un tema (lista de palabras del tenant). */
  | 'asks_about'
  /** Igual, pero solo la PRIMERA vez en la conversación. */
  | 'asks_first_time_about'
  /** El mensaje contiene un texto literal. */
  | 'contains'
  /** El cliente quiere comprar / reservar / reclamar. */
  | 'wants'
  /** Sentimiento negativo detectado. */
  | 'sentiment_negative';

export interface Condition {
  kind: ConditionKind;
  /** Palabras o texto a buscar; para `wants`, el verbo. */
  value: string;
}

export type ActionKind =
  | 'reply'
  | 'send_products'
  | 'send_location'
  | 'send_link'
  | 'capture_field'
  | 'tag'
  | 'handoff'
  | 'pause_ai';

export interface Action {
  kind: ActionKind;
  /** Texto de la respuesta, id del recurso o nombre de la etiqueta. */
  value: string;
}

export interface DeterministicRule {
  id: string;
  name: string;
  /** Menor = se evalúa antes. El dueño las ordena. */
  priority: number;
  /** `all` = tienen que cumplirse todas; `any` = basta una. */
  match: 'all' | 'any';
  conditions: readonly Condition[];
  actions: readonly Action[];
  enabled: boolean;
  /**
   * Franja horaria en la que la regla aplica, en minutos desde medianoche y en
   * hora LOCAL del negocio. `null` = siempre.
   *
   * Se guarda en minutos y no como `"18:00"` porque comparar cadenas de hora es
   * la forma más fácil de equivocarse con el cruce de medianoche, y una regla
   * de «fuera de horario» que no cubre de 23:00 a 01:00 no sirve para nada.
   */
  activeFrom?: number | null;
  activeTo?: number | null;
}

export interface MessageContext {
  text: string;
  /** Temas ya preguntados antes en esta conversación. */
  askedTopics?: readonly string[];
  /** Minutos desde medianoche, hora local del negocio. */
  minuteOfDay?: number;
  sentimentNegative?: boolean;
}

export interface RuleMatch {
  rule: DeterministicRule;
  actions: readonly Action[];
  /** Qué condición disparó, para la traza (RN-AIA-05). */
  matchedBy: readonly string[];
}

/** Palabras que delatan una intención de compra, reserva o reclamo. */
const VERBOS: Record<string, readonly RegExp[]> = {
  comprar: [/\b(?:quiero|quisiera|me das|dame|ped(?:ir|ido)|comprar|llevar)\b/i],
  reservar: [/\b(?:reserv\w+|mesa para|apart\w+)\b/i],
  // Sin `\b` FINAL a propósito: en JavaScript las vocales acentuadas no son
  // caracteres de palabra, así que `\b` detrás de «llegó» no casa nunca y el
  // reclamo más común del negocio —«no llegó»— pasaba desapercibido. El
  // límite inicial sí se mantiene, que es el que evita casar dentro de otra
  // palabra.
  reclamar: [
    /\b(?:reclam\w+|queja|devoluci[oó]n|no lleg[oó]|est[aá] (?:fr[ií]o|mal)|p[eé]simo)/i,
  ],
};

/**
 * Encuentra la PRIMERA regla que dispara, por prioridad.
 *
 * Solo una. Aplicar todas las que coincidan produciría respuestas apiladas
 * —«nuestro horario es… y además tenemos promoción… y te derivo a un humano»—
 * que es exactamente lo que hace que un bot parezca un bot.
 */
export function matchRule(
  rules: readonly DeterministicRule[],
  ctx: MessageContext,
): RuleMatch | null {
  const ordenadas = [...rules]
    .filter((r) => r.enabled)
    .filter((r) => enHorario(r, ctx.minuteOfDay))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      // Desempate estable: sin él, dos reglas con la misma prioridad
      // dispararían una u otra según el orden de la base de datos, y el dueño
      // vería su agente responder distinto sin haber cambiado nada.
      return a.id.localeCompare(b.id);
    });

  for (const regla of ordenadas) {
    const disparadas = regla.conditions.filter((c) => cumple(c, ctx));
    const ok =
      regla.conditions.length > 0 &&
      (regla.match === 'all'
        ? disparadas.length === regla.conditions.length
        : disparadas.length > 0);
    if (ok) {
      return {
        rule: regla,
        actions: regla.actions,
        matchedBy: disparadas.map((c) => `${c.kind}:${c.value}`),
      };
    }
  }
  return null;
}

function cumple(c: Condition, ctx: MessageContext): boolean {
  const texto = ctx.text.toLowerCase();
  const valor = c.value.toLowerCase().trim();

  switch (c.kind) {
    case 'contains':
      return texto.includes(valor);

    case 'asks_about':
      return contieneAlgunaPalabra(texto, valor);

    case 'asks_first_time_about':
      // La segunda vez NO dispara: repetir la misma respuesta enlatada a quien
      // ya la leyó es la señal más clara de que está hablando con una máquina.
      return (
        contieneAlgunaPalabra(texto, valor) &&
        !(ctx.askedTopics ?? []).includes(valor)
      );

    case 'wants': {
      const patrones = VERBOS[valor];
      return patrones ? patrones.some((re) => re.test(ctx.text)) : false;
    }

    case 'sentiment_negative':
      return ctx.sentimentNegative === true;

    default:
      return false;
  }
}

/** `"horario, hora, abren"` → true si el texto menciona alguna. */
function contieneAlgunaPalabra(texto: string, lista: string): boolean {
  return lista
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => texto.includes(p));
}

/**
 * ¿Está la regla en su franja horaria?
 *
 * Soporta el cruce de medianoche: `activeFrom = 1380` (23:00) y
 * `activeTo = 120` (02:00) cubre la madrugada. Sin esto, la regla de «fuera de
 * horario» —que es justo la que más falta hace de noche— nunca dispararía.
 */
function enHorario(
  regla: DeterministicRule,
  minuteOfDay: number | undefined,
): boolean {
  const desde = regla.activeFrom;
  const hasta = regla.activeTo;
  if (desde == null || hasta == null) return true;
  // Sin hora conocida la regla horaria NO aplica: dispararla a ciegas podría
  // dar la respuesta de «estamos cerrados» a mediodía.
  if (minuteOfDay == null) return false;

  return desde <= hasta
    ? minuteOfDay >= desde && minuteOfDay < hasta
    : minuteOfDay >= desde || minuteOfDay < hasta;
}

/** Detección de sentimiento negativo (RN-AIA-03). Léxico, no modelo. */
export function detectNegativeSentiment(text: string): boolean {
  // Deliberadamente por palabras y no por LLM: esto decide si una queja llega a
  // un humano, y tiene que funcionar con el presupuesto agotado y sin red.
  return VERBOS['reclamar']!.some((re) => re.test(text));
}
