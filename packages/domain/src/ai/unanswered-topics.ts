/**
 * Temas preguntados sin fuente que los respalde (spec 19 §6, T5.32).
 *
 * La métrica del panel es «temas más preguntados sin fuente», con la sugerencia
 * «agrega una fuente sobre X». Es, de toda la analítica del agente, la única
 * que le dice al dueño **qué hacer**: las demás describen, esta acciona.
 *
 * Se resuelve con conteo de términos y NO con un modelo, por tres motivos que
 * no son de purismo:
 *
 *  · **Tiene que funcionar con el presupuesto agotado.** Justo cuando se acaban
 *    los créditos es cuando más interesa saber qué está costando tokens sin
 *    tener respuesta preparada.
 *  · **Es reproducible.** Un dueño que ve «agrega una fuente sobre *ceviche*»
 *    tiene que poder pinchar y leer las cinco conversaciones que lo pidieron.
 *    Con un resumen generado, el número y los ejemplos pueden no cuadrar.
 *  · **Es discutible.** Cuando el dueño diga «yo eso no lo he visto nunca», la
 *    respuesta es una lista de mensajes, no «lo dijo el modelo».
 *
 * Lo que NO hace: agrupar sinónimos ni entender la pregunta. «Ceviche» y
 * «cebiche» salen como dos términos. Es una limitación real y está aquí escrita
 * para que nadie lea la lista como si fuera un análisis semántico.
 */

/**
 * Palabras que aparecen en casi cualquier mensaje y no son un tema.
 *
 * Sin esta lista, el resultado sería «que», «hola», «para» en las tres primeras
 * posiciones, en todos los tenants, siempre — un panel que dice lo mismo para
 * todo el mundo no se vuelve a mirar.
 */
const VACIAS = new Set([
  'a',
  'al',
  'algo',
  'alguna',
  'alguno',
  'ahora',
  'aqui',
  'asi',
  'bien',
  'buenas',
  'bueno',
  'buenos',
  'como',
  'con',
  'cual',
  'cuando',
  'cuanto',
  'de',
  'del',
  'donde',
  'dos',
  'el',
  'ella',
  'ellos',
  'en',
  'era',
  'es',
  'esa',
  'ese',
  'eso',
  'esta',
  'estan',
  'este',
  'esto',
  'gracias',
  'hay',
  'hola',
  'hoy',
  'la',
  'las',
  'le',
  'les',
  'lo',
  'los',
  'mas',
  'me',
  'mi',
  'muy',
  'nada',
  'no',
  'nos',
  'o',
  'para',
  'pero',
  'por',
  'porfa',
  'porfavor',
  'porque',
  'que',
  'quiero',
  'se',
  'ser',
  'si',
  'sin',
  'sobre',
  'solo',
  'son',
  'su',
  'sus',
  'tambien',
  'te',
  'tengo',
  'tiene',
  'tienen',
  'todo',
  'todos',
  'un',
  'una',
  'uno',
  'unos',
  'usted',
  'ustedes',
  'ya',
  'yo',
]);

export interface TopicCount {
  /** Término normalizado: minúsculas y sin tildes. */
  term: string;
  /** En cuántos MENSAJES DISTINTOS aparece. */
  messages: number;
  /** Hasta tres mensajes literales, para poder verificar la cifra. */
  examples: string[];
}

export interface UnansweredTopicsOptions {
  /** Cuántos términos devolver. */
  limit?: number;
  /** Mínimo de mensajes para que un término salga. Por defecto 2. */
  minMessages?: number;
}

/**
 * Normaliza para contar: minúsculas, sin tildes y sin puntuación.
 *
 * Sin quitar tildes, «acompañamiento» y «acompanamiento» serían dos temas
 * distintos según cómo escriba cada cliente, que es lo que hace inútil un
 * conteo de texto libre en castellano.
 */
function normalizar(texto: string): string[] {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Cuenta los términos significativos de un conjunto de mensajes.
 *
 * `texts` son los mensajes que se resolvieron **sin ninguna fuente ni
 * herramienta detrás**: los que el agente contestó a pulso. Pasarle todos los
 * mensajes daría la lista de lo más preguntado, que es otra métrica y no la
 * que pide la spec.
 */
export function unansweredTopics(
  texts: readonly string[],
  options: UnansweredTopicsOptions = {},
): TopicCount[] {
  const limite = options.limit ?? 10;
  const minimo = options.minMessages ?? 2;

  const conteo = new Map<string, { messages: number; examples: string[] }>();

  for (const texto of texts) {
    // Por MENSAJE y no por aparición: quien escribe «pollo pollo pollo» no
    // convierte «pollo» en un tema tres veces más urgente.
    const unicos = new Set(
      normalizar(texto).filter((p) => p.length > 3 && !VACIAS.has(p)),
    );
    for (const termino of unicos) {
      const actual = conteo.get(termino) ?? { messages: 0, examples: [] };
      actual.messages += 1;
      if (actual.examples.length < 3) actual.examples.push(texto);
      conteo.set(termino, actual);
    }
  }

  return [...conteo.entries()]
    .filter(([, v]) => v.messages >= minimo)
    .map(([term, v]) => ({
      term,
      messages: v.messages,
      examples: v.examples,
    }))
    .sort((a, b) => {
      if (a.messages !== b.messages) return b.messages - a.messages;
      // Desempate alfabético: sin él, dos términos empatados saldrían en el
      // orden en que llegaron los mensajes y el panel cambiaría de una recarga
      // a otra sin que hubiera pasado nada.
      return a.term.localeCompare(b.term);
    })
    .slice(0, limite);
}
