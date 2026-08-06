/**
 * Máquina de estados finita, tipada y pura. Base reutilizable para el
 * orquestador de pedidos (F4) y cualquier flujo con estados discretos.
 *
 * Principios:
 *  - Las transiciones válidas se declaran explícitamente; una transición no
 *    declarada es un error, nunca un salto silencioso.
 *  - Es pura: no hace I/O. El efecto (persistir, emitir outbox) lo aplica el
 *    caso de uso que la envuelve dentro de su transacción.
 */

export class InvalidTransitionError<
  S extends string,
  E extends string,
> extends Error {
  constructor(
    readonly from: S,
    readonly event: E,
  ) {
    super(
      `Transición inválida: no se puede aplicar "${event}" desde el estado "${from}".`,
    );
    this.name = 'InvalidTransitionError';
  }
}

/** Mapa de transiciones: por estado, qué evento lleva a qué estado destino. */
export type TransitionMap<S extends string, E extends string> = {
  readonly [From in S]?: {
    readonly [Ev in E]?: S;
  };
};

export interface StateMachineDefinition<S extends string, E extends string> {
  readonly initial: S;
  readonly transitions: TransitionMap<S, E>;
  /** Estados finales (sin salida). Opcional; se documenta el flujo. */
  readonly finalStates?: readonly S[];
}

export class StateMachine<S extends string, E extends string> {
  constructor(private readonly def: StateMachineDefinition<S, E>) {}

  get initial(): S {
    return this.def.initial;
  }

  /** ¿Existe una transición declarada para (from, event)? */
  can(from: S, event: E): boolean {
    return this.def.transitions[from]?.[event] !== undefined;
  }

  /** Estado destino de aplicar `event` en `from`. Lanza si no es válida. */
  next(from: S, event: E): S {
    const to = this.def.transitions[from]?.[event];
    if (to === undefined) {
      throw new InvalidTransitionError(from, event);
    }
    return to;
  }

  /** ¿Es `state` un estado final (sin transiciones de salida)? */
  isFinal(state: S): boolean {
    if (this.def.finalStates?.includes(state)) {
      return true;
    }
    const outgoing = this.def.transitions[state];
    return outgoing === undefined || Object.keys(outgoing).length === 0;
  }

  /** Eventos aplicables desde un estado dado. */
  allowedEvents(from: S): E[] {
    const outgoing = this.def.transitions[from];
    return outgoing ? (Object.keys(outgoing) as E[]) : [];
  }
}
