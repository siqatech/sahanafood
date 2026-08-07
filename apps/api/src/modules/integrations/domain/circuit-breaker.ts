/**
 * Cortacircuitos por conector (RN-INT-03: bulkhead por proveedor).
 *
 * El problema real que resuelve: cuando Rappi se cae, cada intento de propagar
 * disponibilidad se queda esperando el timeout. Con suficientes intentos en
 * vuelo se agotan las conexiones del pool y deja de funcionar TODO — incluido
 * el POS de la tienda, que no tiene nada que ver con Rappi. El cortacircuitos
 * corta rápido en vez de esperar, y el aislamiento es por conexión: que un
 * proveedor esté abierto no afecta a los demás.
 *
 * Es una función pura del estado almacenado en `int_connections` (fallos
 * consecutivos y momento de apertura), sin temporizadores ni estado en memoria:
 * así el estado sobrevive a un reinicio y lo comparten todas las instancias.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitSnapshot {
  consecutiveFailures: number;
  circuitOpenedAt: Date | null;
}

export interface CircuitPolicy {
  /** Fallos consecutivos que abren el circuito. */
  failureThreshold: number;
  /** Tiempo que permanece abierto antes de dejar pasar una prueba. */
  openMs: number;
}

export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = {
  failureThreshold: 5,
  openMs: 30_000,
};

/**
 * Estado efectivo del circuito en un instante dado.
 *
 * `half_open` no es un estado guardado sino derivado: «lleva abierto más del
 * tiempo de espera». Derivarlo en vez de guardarlo evita el problema clásico de
 * dos instancias que se pisan al cambiar de open a half_open.
 */
export function circuitState(
  snapshot: CircuitSnapshot,
  now: Date,
  policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY,
): CircuitState {
  if (snapshot.circuitOpenedAt === null) return 'closed';
  const abiertoDesdeMs = now.getTime() - snapshot.circuitOpenedAt.getTime();
  return abiertoDesdeMs >= policy.openMs ? 'half_open' : 'open';
}

/** ¿Se permite intentar la llamada ahora? */
export function circuitAllows(
  snapshot: CircuitSnapshot,
  now: Date,
  policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY,
): boolean {
  return circuitState(snapshot, now, policy) !== 'open';
}

/**
 * Nuevo estado tras un intento. Devuelve el snapshot a persistir.
 *
 * Un éxito cierra el circuito por completo, incluso desde `half_open`: la
 * prueba pasó, no hay motivo para seguir castigando al proveedor. Un fallo en
 * `half_open` vuelve a abrirlo con el reloj a cero, que es lo que evita el
 * martilleo contra un servicio que sigue caído.
 */
export function afterAttempt(
  snapshot: CircuitSnapshot,
  outcome: 'success' | 'failure',
  now: Date,
  policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY,
): CircuitSnapshot {
  if (outcome === 'success') {
    return { consecutiveFailures: 0, circuitOpenedAt: null };
  }

  const fallos = snapshot.consecutiveFailures + 1;
  const estabaAbierto = snapshot.circuitOpenedAt !== null;

  if (estabaAbierto) {
    // Falló la prueba de half_open (o llegó un fallo mientras estaba abierto):
    // se reinicia la cuenta atrás.
    return { consecutiveFailures: fallos, circuitOpenedAt: now };
  }
  return {
    consecutiveFailures: fallos,
    circuitOpenedAt: fallos >= policy.failureThreshold ? now : null,
  };
}

export class CircuitOpenError extends Error {
  constructor(readonly provider: string) {
    super(
      `El conector "${provider}" tiene el circuito abierto: se corta la llamada en vez de esperar al timeout.`,
    );
    this.name = 'CircuitOpenError';
  }
}
