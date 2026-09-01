import type { TrazaDeAgente } from '../../../lib/panel-api';

/**
 * Cómo se lee una traza del agente (RN-AIA-05, ADR-0011).
 *
 * CLAUDE.md lo pide en una línea: «toda respuesta IA deja traza». La traza se
 * escribía desde T5.24 y **nadie podía leerla**, que es media garantía: sirve
 * para un `psql` a las once de la noche, no para que quien atiende entienda
 * por qué el bot contestó lo que contestó justo antes de pasarle el cliente.
 *
 * Este módulo es puro a propósito —solo traduce— para poder probar el texto
 * exacto que va a leer una persona. El vocabulario evita «LLM», «prompt» y
 * «token»: quien abre esto sabe de pollos a la brasa, no de modelos.
 */

/** Cómo se resolvió el turno. El orden es el de la jerarquía de ADR-0011. */
export type Resolucion = 'rule' | 'llm' | 'blocked' | 'handoff' | 'degraded';

export interface LecturaDeTraza {
  /** Etiqueta corta, la que va en la píldora. */
  rotulo: string;
  /** Una frase que explica qué pasó, en castellano de negocio. */
  explicacion: string;
  /**
   * `revision` cuando el turno merece que alguien lo mire —se bloqueó una
   * respuesta o se acabó el presupuesto— y `normal` cuando no.
   */
  tono: 'normal' | 'revision';
}

const LECTURAS: Record<Resolucion, LecturaDeTraza> = {
  rule: {
    rotulo: 'Regla tuya',
    explicacion:
      'Contestó una regla que configuraste. No intervino el modelo, así que no pudo inventarse nada ni costó créditos.',
    tono: 'normal',
  },
  llm: {
    rotulo: 'Redactó el asistente',
    explicacion:
      'No había regla para esto, así que redactó el asistente. Los datos que cita salen de las herramientas de abajo, no de su memoria.',
    tono: 'normal',
  },
  blocked: {
    rotulo: 'Bloqueado',
    explicacion:
      'El asistente escribió algo que el validador no dejó salir. Abajo está lo que quería decir: si es correcto, te falta una regla; si no, el validador hizo su trabajo.',
    tono: 'revision',
  },
  handoff: {
    rotulo: 'Te lo pasó a ti',
    explicacion:
      'Derivó a una persona en vez de contestar. Pasa con reclamos (RN-AIA-03), con el agente apagado y cuando la respuesta no estaba respaldada.',
    tono: 'normal',
  },
  degraded: {
    rotulo: 'Sin presupuesto',
    explicacion:
      'Se agotaron los créditos de IA del mes: el asistente dejó de redactar y derivó. Las reglas deterministas siguen funcionando.',
    tono: 'revision',
  },
};

export function leerResolucion(resolucion: string): LecturaDeTraza {
  return (
    LECTURAS[resolucion as Resolucion] ?? {
      rotulo: resolucion,
      // Una resolución que no conocemos NO se pinta como si fuera normal: es
      // una versión del servidor más nueva que esta pantalla, y decir «todo en
      // orden» sobre algo que no sabemos leer es la peor de las respuestas.
      explicacion: 'Resolución desconocida para esta pantalla.',
      tono: 'revision',
    }
  );
}

/**
 * Las herramientas que se llamaron, ya legibles.
 *
 * El campo es `jsonb` y llega como `unknown`: la traza es de auditoría y se
 * escribió con la forma que tenía el agente ese día, no necesariamente la de
 * hoy. Cualquier cosa que no sea una lista de textos se ignora en vez de
 * romper la pantalla — una traza vieja mal formada no puede impedir leer las
 * cinco que sí importan.
 */
export function herramientas(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];
  return valor.filter((v): v is string => typeof v === 'string' && v !== '');
}

export interface VeredictoDelValidador {
  ok: boolean;
  motivo: string | null;
}

/** Qué dijo el validador de salida (T5.24). `null` cuando no llegó a correr. */
export function veredicto(valor: unknown): VeredictoDelValidador | null {
  if (typeof valor !== 'object' || valor === null) return null;
  const v = valor as Record<string, unknown>;
  if (typeof v['ok'] !== 'boolean') return null;
  const motivo = v['reason'];
  return { ok: v['ok'], motivo: typeof motivo === 'string' ? motivo : null };
}

/**
 * El resumen de arriba: cuántos turnos, cuántos los resolvió una regla y
 * cuántos hubo que mirar.
 *
 * La proporción de reglas es **la** métrica de ADR-0011: cada turno que
 * resuelve una regla es uno que no cuesta créditos y que no puede inventarse
 * un precio. Si baja, al dueño le faltan reglas.
 */
export interface ResumenDeTrazas {
  turnos: number;
  porRegla: number;
  aRevisar: number;
  creditos: number;
}

export function resumirTrazas(
  trazas: readonly TrazaDeAgente[],
): ResumenDeTrazas {
  return {
    turnos: trazas.length,
    porRegla: trazas.filter((t) => t.resolution === 'rule').length,
    aRevisar: trazas.filter(
      (t) => leerResolucion(t.resolution).tono === 'revision',
    ).length,
    creditos: trazas.reduce((suma, t) => suma + t.credits, 0),
  };
}
