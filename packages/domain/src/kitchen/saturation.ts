/**
 * Saturación de cocina (RN-KIT-04, spec 07 — T5.18, paga DT-03).
 *
 * La regla, literal: «ítems activos > max_concurrent → `kitchen.saturated` →
 * `promised_at` +X min en `received`; segundo umbral → pausa de canales por
 * política (orden: menor margen primero)».
 *
 * Lo que esta función existe para evitar es concreto: **una cocina que acepta
 * más de lo que puede producir**. No falla nada —los pedidos entran, la caja
 * cobra, el KDS los pinta—; simplemente todos salen tarde, y el cliente se
 * entera cuando ya pagó. Frenar la entrada es lo único que lo corrige, y por
 * eso la decisión vive en el dominio, se prueba con casos concretos y no se
 * esconde en un `if` dentro de un servicio.
 *
 * Dos umbrales y no uno, a propósito:
 *
 *  · El **primero es honesto, no restrictivo**: se sigue vendiendo, pero se
 *    promete más tarde. Un cliente que pide a las 20:30 y le dicen 55 min en
 *    vez de 35 no se va; uno al que le prometen 35 y llega en 55, sí.
 *  · El **segundo frena la entrada**, y solo entonces. Cerrar canales es
 *    perder ventas; hacerlo al primer pico es cerrarse en la mejor hora del
 *    día.
 */

export interface KitchenLoad {
  /** Ítems (unidades, no tickets) en marcha ahora mismo. */
  activeItems: number;
  /** Tickets que ya pasaron su promesa. Informativo, no decide. */
  lateTickets?: number;
}

export interface SaturationPolicy {
  /** Primer umbral: por encima se extienden las promesas. */
  maxConcurrentItems: number;
  /** Minutos que se añaden a la promesa de los pedidos aún en `received`. */
  extendMinutes: number;
  /**
   * Segundo umbral: por encima se pausan canales. `null` = nunca se pausa
   * automáticamente, que es la configuración de quien prefiere decidirlo a
   * mano.
   */
  pauseThresholdItems: number | null;
  /**
   * Canales en el ORDEN en que se pausarían: el primero es el que más caro
   * sale servir, es decir el de menor margen.
   *
   * Es una lista explícita y no un cálculo sobre la comisión vigente. Podría
   * derivarse —más comisión, menos margen—, pero entonces renegociar una
   * tarifa en marzo cambiaría en silencio qué canal se cierra en hora punta,
   * y eso es una decisión de negocio que el dueño tiene que poder ver y
   * cambiar. La API sí puede SUGERIR este orden a partir de las comisiones.
   */
  channelPauseOrder: readonly string[];
}

export type SaturationLevel = 'normal' | 'saturated' | 'critical';

export interface SaturationDecision {
  level: SaturationLevel;
  /** Minutos a añadir a la promesa. 0 en `normal`. */
  extendPromiseMinutes: number;
  /** Canales que deben quedar pausados AHORA. Vacío salvo en `critical`. */
  channelsToPause: readonly string[];
  /** Explicación para el KDS y el registro de auditoría. */
  reason: string;
}

export class SaturationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaturationError';
  }
}

export function assertValidPolicy(policy: SaturationPolicy): void {
  if (!Number.isInteger(policy.maxConcurrentItems) || policy.maxConcurrentItems <= 0) {
    throw new SaturationError(
      'El umbral de saturación tiene que ser un entero positivo.',
    );
  }
  if (!Number.isInteger(policy.extendMinutes) || policy.extendMinutes <= 0) {
    // Extender cero minutos sería declararse saturado y no hacer nada, que es
    // peor que no declararse: el KDS se pone en rojo y nadie entiende por qué.
    throw new SaturationError(
      'La extensión de promesa tiene que ser de al menos un minuto.',
    );
  }
  if (policy.pauseThresholdItems !== null) {
    if (
      !Number.isInteger(policy.pauseThresholdItems) ||
      policy.pauseThresholdItems <= policy.maxConcurrentItems
    ) {
      // Un segundo umbral por debajo del primero haría que la cocina pasara
      // directamente de normal a cerrar canales, saltándose el aviso.
      throw new SaturationError(
        'El umbral de pausa tiene que ser mayor que el de saturación.',
      );
    }
    if (policy.channelPauseOrder.length === 0) {
      throw new SaturationError(
        'Con umbral de pausa hay que declarar en qué orden se pausan los canales.',
      );
    }
  }
}

/**
 * Qué hacer con la carga actual.
 *
 * Es **pura y sin estado**: dice qué debe ser cierto AHORA, no qué cambió. El
 * servicio compara con lo que ya estaba y aplica solo la diferencia. Devolver
 * un delta desde aquí obligaría a esta función a conocer el estado anterior, y
 * entonces dos llamadas seguidas con la misma carga darían resultados
 * distintos — justo lo que hace imposible probarla.
 */
export function evaluateSaturation(
  load: KitchenLoad,
  policy: SaturationPolicy,
): SaturationDecision {
  assertValidPolicy(policy);

  const items = load.activeItems;

  if (
    policy.pauseThresholdItems !== null &&
    items > policy.pauseThresholdItems
  ) {
    return {
      level: 'critical',
      extendPromiseMinutes: policy.extendMinutes,
      channelsToPause: policy.channelPauseOrder,
      reason:
        `${items} ítems en marcha, por encima del umbral crítico de ` +
        `${policy.pauseThresholdItems}: se pausan los canales de menor margen.`,
    };
  }

  if (items > policy.maxConcurrentItems) {
    return {
      level: 'saturated',
      extendPromiseMinutes: policy.extendMinutes,
      channelsToPause: [],
      reason:
        `${items} ítems en marcha, por encima de ${policy.maxConcurrentItems}: ` +
        `se promete ${policy.extendMinutes} min más.`,
    };
  }

  return {
    level: 'normal',
    extendPromiseMinutes: 0,
    channelsToPause: [],
    reason: `${items} ítems en marcha, dentro de la capacidad.`,
  };
}

/**
 * Orden de pausa SUGERIDO a partir de la comisión de cada canal.
 *
 * Más comisión = menos margen = se cierra antes. Es una sugerencia para
 * rellenar la configuración la primera vez, no la fuente de verdad: lo que se
 * aplica es `channelPauseOrder`, que el dueño puede ordenar como quiera —hay
 * motivos legítimos para no cerrar el canal más caro, como un contrato de
 * exclusividad o una promoción en marcha.
 */
export function suggestPauseOrder(
  channels: ReadonlyArray<{ channel: string; commissionBps: number }>,
): string[] {
  return [...channels]
    .sort((a, b) => {
      if (a.commissionBps !== b.commissionBps) {
        return b.commissionBps - a.commissionBps;
      }
      // Desempate estable por nombre: sin él, dos canales con la misma
      // comisión saldrían en el orden que devuelva la base de datos y la
      // sugerencia cambiaría entre dos pantallas abiertas a la vez.
      return a.channel.localeCompare(b.channel);
    })
    .map((c) => c.channel);
}
