/**
 * Validador de salida del agente (RN-AIA-01, T5.24).
 *
 * **Es el corazón de la fase, junto con el webhook de pago de T5.03**, y por el
 * mismo motivo: un fallo aquí no es un bug. Es un precio inventado que el
 * cliente lee, acepta y reclama; o una promesa de stock que no existe; o una
 * zona a la que no llegamos y a la que alguien ya está esperando su comida.
 *
 * La regla, literal: *«precio, stock, zona u horario en una respuesta DEBEN
 * provenir de una llamada a herramienta en esa conversación»*.
 *
 * La forma de comprobarlo es la que importa y merece explicarse, porque la
 * obvia es la mala. Lo obvio sería pedirle al modelo que no invente: una
 * instrucción en el prompt. Eso no es un control, es un deseo — el modelo la
 * cumple casi siempre, y «casi» aplicado a precios es exactamente el problema.
 * Aquí se hace al revés: se lee lo que el modelo QUIERE decir, se extrae todo
 * lo que parece un dato duro, y **cada uno tiene que estar respaldado por una
 * herramienta que se llamó de verdad en esta conversación**. Sin respaldo, la
 * respuesta no sale.
 *
 * Es un validador CONSERVADOR a propósito: prefiere bloquear una respuesta
 * correcta que dejar pasar una inventada. Bloquear cuesta una reformulación o
 * una derivación a un humano; dejar pasar cuesta un cliente.
 */

export type FactKind = 'price' | 'stock' | 'coverage' | 'hours';

/** Un dato duro que el agente afirmó en su respuesta. */
export interface AssertedFact {
  kind: FactKind;
  /** El texto exacto encontrado. Va en el motivo del bloqueo. */
  text: string;
}

/** Lo que una herramienta devolvió de verdad en ESTA conversación. */
export interface ToolEvidence {
  /** `catalog.search`, `org.coverage`, … */
  tool: string;
  kinds: readonly FactKind[];
  /**
   * Valores concretos que la herramienta devolvió, normalizados.
   *
   * Para precios, los céntimos como cadena («320000»). Comparar contra los
   * valores y no solo contra «se llamó a una herramienta de precios» es lo que
   * impide el fallo más probable: el modelo consulta el precio del pollo y
   * luego cita el de la gaseosa, o redondea 32,00 a «unos 30».
   */
  values: readonly string[];
}

export type ValidationVerdict =
  | { ok: true; facts: readonly AssertedFact[] }
  | {
      ok: false;
      /** Qué se afirmó sin respaldo. */
      unsupported: readonly AssertedFact[];
      code: 'UNSUPPORTED_FACT' | 'FORBIDDEN_TOPIC' | 'TOO_LONG';
      reason: string;
    };

export interface ValidatorOptions {
  /** Máximo de caracteres. Una respuesta larga en WhatsApp no se lee. */
  maxLength?: number;
  /** Temas vedados propios del tenant, además de los fijos de ADR-0011. */
  forbiddenTopics?: readonly string[];
}

/**
 * Guardrails FIJOS, no configurables (ADR-0011 §6).
 *
 * Un tenant no puede desactivarlos. La lista es corta a propósito: cada entrada
 * es algo que, dicho por un bot de comida, mete al negocio en un problema que
 * no sabe gestionar.
 */
const TEMAS_VEDADOS_FIJOS = [
  // Consejo médico o dietético con apariencia de autoridad.
  /\b(?:cura|curar|adelgaz\w+|tratamiento médico|receta médica)\b/i,
  // Promesas legales o de reembolso que el agente no puede honrar.
  /\b(?:te (?:garantizo|aseguro) (?:que|el)|garantía legal|te devolvemos el dinero)\b/i,
  // Promociones inventadas: la trampa clásica del bot vendedor.
  /\b(?:promoción especial solo para ti|descuento exclusivo que te doy)\b/i,
];

const LONGITUD_MAXIMA = 900;

/**
 * Patrones de dato duro.
 *
 * Deliberadamente AMPLIOS. Un patrón que se le escapa un precio es un precio
 * inventado que sale; uno que marca de más provoca una reformulación. El coste
 * de los dos errores no se parece.
 */
const PATRONES: ReadonlyArray<{ kind: FactKind; re: RegExp }> = [
  // Importes: «S/ 32», «32.50 soles», «32,50». Con o sin símbolo.
  { kind: 'price', re: /(?:S\/\.?\s*|\bsoles?\s*)?\b\d{1,4}(?:[.,]\d{1,2})?\s*(?:soles?|PEN)\b/gi },
  { kind: 'price', re: /\bS\/\.?\s*\d{1,4}(?:[.,]\d{1,2})?/gi },
  // Disponibilidad afirmada.
  {
    kind: 'stock',
    re: /\b(?:s[ií]\s+(?:hay|tenemos)|tenemos|nos quedan|queda[n]?|disponible[s]?|en stock|agotado[s]?|sin stock)\b/gi,
  },
  // Cobertura y envío.
  {
    kind: 'coverage',
    re: /\b(?:s[ií]\s+llegamos|llegamos|repartimos|delivery|env[ií]o|cobertura|zona de reparto)\b/gi,
  },
  // Horarios.
  {
    kind: 'hours',
    re: /\b(?:abrimos|cerramos|abierto|cerrado|horario|atendemos)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|h(?:oras)?)\b/gi,
  },
];

/** Extrae los datos duros que una respuesta afirma. */
export function extractFacts(text: string): AssertedFact[] {
  const encontrados: AssertedFact[] = [];
  const vistos = new Set<string>();

  for (const { kind, re } of PATRONES) {
    // `lastIndex` se reinicia: los regex globales guardan estado entre usos y
    // reutilizar uno sucio se salta coincidencias de forma intermitente, que es
    // el peor modo de fallo posible en un validador.
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const clave = `${kind}:${m[0].toLowerCase().trim()}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      encontrados.push({ kind, text: m[0].trim() });
    }
  }
  return encontrados;
}

/** Números de una cadena, normalizados a céntimos de escala 4. */
function importesEnCentimos(text: string): string[] {
  const salida: string[] = [];
  for (const m of text.matchAll(/\d{1,6}(?:[.,]\d{1,2})?/g)) {
    const normalizado = m[0].replace(',', '.');
    const valor = Number(normalizado);
    if (!Number.isFinite(valor)) continue;
    salida.push(String(Math.round(valor * 10_000)));
  }
  return salida;
}

/**
 * ¿Sale esta respuesta?
 *
 * El orden de las comprobaciones no es casual: primero los temas vedados
 * —porque una respuesta prohibida no mejora por estar bien respaldada—, luego
 * la longitud, y al final el respaldo de los datos, que es la cara.
 */
export function validateOutput(
  text: string,
  evidence: readonly ToolEvidence[],
  options: ValidatorOptions = {},
): ValidationVerdict {
  const vedados = [
    ...TEMAS_VEDADOS_FIJOS,
    ...(options.forbiddenTopics ?? []).map(
      (t) => new RegExp(escaparRegExp(t), 'i'),
    ),
  ];
  for (const re of vedados) {
    const m = re.exec(text);
    if (m) {
      return {
        ok: false,
        unsupported: [],
        code: 'FORBIDDEN_TOPIC',
        reason: `La respuesta toca un tema vedado ("${m[0]}").`,
      };
    }
  }

  const maxLength = options.maxLength ?? LONGITUD_MAXIMA;
  if (text.length > maxLength) {
    return {
      ok: false,
      unsupported: [],
      code: 'TOO_LONG',
      reason: `La respuesta tiene ${text.length} caracteres y el máximo es ${maxLength}.`,
    };
  }

  const facts = extractFacts(text);
  if (facts.length === 0) return { ok: true, facts };

  const kindsConEvidencia = new Set<FactKind>();
  const valoresRespaldados = new Set<string>();
  for (const e of evidence) {
    for (const k of e.kinds) kindsConEvidencia.add(k);
    for (const v of e.values) valoresRespaldados.add(v);
  }

  const sinRespaldo = facts.filter((f) => {
    if (!kindsConEvidencia.has(f.kind)) return true;

    // Para los precios NO basta con que se llamara a una herramienta de
    // precios: el importe citado tiene que ser uno de los que devolvió. Es lo
    // que impide el fallo más probable de todos —consultar el precio del pollo
    // y citar el de la gaseosa, o redondear 32,00 a «unos 30»—, y es
    // justamente el que una comprobación por tipo dejaría pasar.
    if (f.kind === 'price') {
      const citados = importesEnCentimos(f.text);
      if (citados.length === 0) return false;
      return !citados.every((c) => valoresRespaldados.has(c));
    }
    return false;
  });

  if (sinRespaldo.length > 0) {
    return {
      ok: false,
      unsupported: sinRespaldo,
      code: 'UNSUPPORTED_FACT',
      reason:
        'La respuesta afirma datos que ninguna herramienta respaldó en esta ' +
        `conversación: ${sinRespaldo.map((f) => `"${f.text}"`).join(', ')}.`,
    };
  }

  return { ok: true, facts };
}

function escaparRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
