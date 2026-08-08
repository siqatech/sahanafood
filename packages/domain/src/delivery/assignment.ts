/**
 * Asignación de repartidor (RN-DLV-01, spec 09).
 *
 * La regla, literal: **zona + carga + antigüedad de promesa; empate → menor
 * carga.**
 *
 * Es pura y vive aquí, no en el servidor, porque es la decisión que más se va a
 * discutir cuando un repartidor diga «a mí siempre me toca lo lejos». Poder
 * ejecutarla sobre un caso concreto y ver por qué salió quien salió vale más
 * que cualquier explicación.
 *
 * En F5 la asignación es MANUAL: esto puntúa y ordena la lista que ve el
 * encargado, con el motivo escrito. La automática de F6 usará la misma función,
 * y por eso devuelve el ranking entero y no solo el ganador — enseñar «este, y
 * estos otros dos por si acaso» es lo que hace que un humano confíe en ella
 * antes de dejarla suelta.
 */

export interface CourierLoad {
  courierId: string;
  /** Nombre de pila, para poder explicar la decisión sin buscar en otra tabla. */
  name: string;
  /** Envíos ya asignados y sin entregar. Es LA variable que ordena. */
  activeShipments: number;
  /** Zonas que este repartidor cubre. Vacío = cubre todas. */
  zoneIds: readonly string[];
  /** `off` no entra en el ranking ni aunque sea el único. */
  status: 'available' | 'busy' | 'off';
}

export interface AssignmentRequest {
  zoneId: string | null;
  /** Cuándo se prometió el pedido. Cuanto más antiguo, más urgente. */
  promisedAt: Date;
  now?: Date;
}

export interface RankedCourier {
  courierId: string;
  name: string;
  activeShipments: number;
  /** Menor es mejor. Sirve para ordenar, no para enseñar al usuario. */
  score: number;
  /** Por qué está donde está, en castellano. Se enseña en la UI. */
  reason: string;
}

export class AssignmentError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_COURIER_AVAILABLE',
  ) {
    super(message);
    this.name = 'AssignmentError';
  }
}

/**
 * Peso de cada envío activo en el score.
 *
 * Alto a propósito: dentro de la zona, la carga es lo que ordena. Repartir mal
 * el trabajo es lo que hace que un pedido espere media hora a que alguien
 * termine sus otros cuatro mientras otro repartidor está parado.
 */
const PESO_CARGA = 100;

/** Cuánto vale un minuto de retraso sobre la promesa. */
const PESO_MINUTO_RETRASO = 1;

/**
 * Ordena a los repartidores para un envío. El primero es el recomendado.
 *
 * **La zona es un filtro, no una preferencia.** Se leyó primero al revés —todos
 * en la lista, con una bonificación para quien cubre la zona— y era peor: si un
 * repartidor declara zonas es porque hay un motivo real (conoce el distrito,
 * tiene el permiso, es donde vive), y un score puede mandarle fuera de ellas
 * solo porque va menos cargado. La regla de la spec además nombra la zona
 * primero: «zona + carga + antigüedad».
 *
 * Los `off` se excluyen; los `busy` NO —un repartidor ocupado sigue siendo
 * candidato, solo que con su carga contada—. Excluirlos dejaría la cola parada
 * en hora punta, que es justo cuando hace falta que se mueva.
 */
export function rankCouriers(
  couriers: readonly CourierLoad[],
  request: AssignmentRequest,
): RankedCourier[] {
  const now = request.now ?? new Date();
  const minutosDeRetraso = Math.max(
    0,
    Math.floor((now.getTime() - request.promisedAt.getTime()) / 60_000),
  );

  const candidatos = couriers.filter((c) => c.status !== 'off');

  const cubreLaZona = (c: CourierLoad): boolean =>
    // Sin zonas declaradas = cubre todas. Es el caso del negocio de un solo
    // local, que es la mayoría, y obligarle a declarar zonas para poder
    // asignar sería burocracia sin beneficio.
    c.zoneIds.length === 0 ||
    request.zoneId === null ||
    c.zoneIds.includes(request.zoneId);

  const conZona = candidatos.filter(cubreLaZona);

  // Si NADIE cubre la zona no se devuelve vacío: se devuelven todos, avisando.
  // Un pedido sin repartidor posible es un pedido que no sale; es preferible
  // que el encargado mande a alguien de fuera de zona sabiéndolo.
  const elegibles = conZona.length > 0 ? conZona : candidatos;
  const fueraDeZona = conZona.length === 0;

  if (elegibles.length === 0) {
    throw new AssignmentError(
      'No hay ningún repartidor disponible ahora mismo.',
      'NO_COURIER_AVAILABLE',
    );
  }

  return elegibles
    .map((c) => {
      // Todos los que llegan aquí cubren la zona (o nadie la cubre), así que la
      // zona ya no puntúa: ordena la CARGA. El retraso resta a todos por igual
      // —no cambia quién gana— pero hace comparables dos envíos distintos
      // cuando la UI los enseña en la misma lista.
      const score =
        c.activeShipments * PESO_CARGA - minutosDeRetraso * PESO_MINUTO_RETRASO;

      return {
        courierId: c.courierId,
        name: c.name,
        activeShipments: c.activeShipments,
        score,
        reason: motivo(c, fueraDeZona, minutosDeRetraso),
      };
    })
    .sort((a, b) => {
      // El desempate de la regla: **menor carga**. Explícito y no implícito en
      // el score, porque el score mezcla varias cosas y dos repartidores pueden
      // empatar en él con cargas distintas.
      if (a.score !== b.score) return a.score - b.score;
      if (a.activeShipments !== b.activeShipments) {
        return a.activeShipments - b.activeShipments;
      }
      // Último desempate por id: sin él el orden depende del que devuelva la
      // base de datos, y la misma consulta daría recomendaciones distintas en
      // dos pantallas abiertas a la vez.
      return a.courierId.localeCompare(b.courierId);
    });
}

function motivo(
  c: CourierLoad,
  fueraDeZona: boolean,
  minutosDeRetraso: number,
): string {
  const partes: string[] = [];
  partes.push(
    c.activeShipments === 0
      ? 'sin envíos activos'
      : `${c.activeShipments} envío${c.activeShipments === 1 ? '' : 's'} en curso`,
  );
  if (fueraDeZona) partes.push('FUERA de la zona del pedido');
  else if (c.zoneIds.length > 0) partes.push('cubre la zona');
  if (c.status === 'busy') partes.push('marcado como ocupado');
  if (minutosDeRetraso > 0) {
    partes.push(`el pedido lleva ${minutosDeRetraso} min de retraso`);
  }
  return partes.join('; ');
}

/** El recomendado. Atajo para quien solo quiere uno. */
export function pickCourier(
  couriers: readonly CourierLoad[],
  request: AssignmentRequest,
): RankedCourier {
  const ranking = rankCouriers(couriers, request);
  return ranking[0]!;
}
