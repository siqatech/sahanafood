/**
 * Geometría de zonas de cobertura (RN-ORG-02).
 *
 * Vive en `@sahana/domain` —y no como consulta PostGIS— por la misma razón que
 * `Money`: la cobertura la evalúan la tienda web, el agente de IA, el POS y el
 * servidor, y las cuatro deben dar EXACTAMENTE la misma respuesta. Un cliente
 * al que la tienda le acepta la dirección y el servidor se la rechaza es un
 * pedido perdido. Además, el cliente offline puede validar cobertura sin red.
 *
 * Ver ADR-0015 para el análisis frente a PostGIS y el disparador de migración.
 *
 * Convención de coordenadas: `[lng, lat]` en grados decimales, igual que
 * GeoJSON (RFC 7946). Un polígono es un anillo cerrado o abierto; el cierre se
 * asume. A escala de una ciudad, tratar los grados como plano introduce un
 * error muy por debajo de la precisión de un GPS de teléfono, así que el
 * cálculo es planar y exacto para el propósito.
 */

/** Punto geográfico `[lng, lat]` en grados decimales (orden GeoJSON). */
export type Position = readonly [lng: number, lat: number];

/** Anillo de un polígono. Se asume cerrado (el último une con el primero). */
export type Ring = readonly Position[];

export class GeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoError';
  }
}

/** Rectángulo envolvente, usado para descartar polígonos baratos y rápido. */
export interface BoundingBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

function assertRing(ring: Ring): void {
  if (ring.length < 3) {
    throw new GeoError('Un polígono necesita al menos 3 vértices.');
  }
}

/** Calcula el rectángulo envolvente de un anillo. */
export function boundingBox(ring: Ring): BoundingBox {
  assertRing(ring);
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/**
 * Tolerancia por defecto al decidir si un punto está sobre el borde.
 * Absorbe el error de punto flotante de coordenadas en grados decimales.
 */
export const BOUNDARY_EPSILON = 1e-12;

/**
 * ¿El punto cae dentro del rectángulo envolvente (bordes incluidos)?
 *
 * `tolerance` expande el rectángulo. Es necesario cuando esto se usa como
 * pre-filtro barato de `isPointInPolygon`: si el filtro fuera exacto y la
 * detección de frontera tolerante, el filtro descartaría puntos que el cálculo
 * exacto sí aceptaría — un cliente justo en el límite quedaría fuera de zona
 * según el redondeo. El pre-filtro nunca debe ser más estricto que el cálculo
 * al que precede.
 */
export function inBoundingBox(
  point: Position,
  box: BoundingBox,
  tolerance = 0,
): boolean {
  const [lng, lat] = point;
  return (
    lng >= box.minLng - tolerance &&
    lng <= box.maxLng + tolerance &&
    lat >= box.minLat - tolerance &&
    lat <= box.maxLat + tolerance
  );
}

/**
 * ¿El punto está exactamente sobre el segmento a–b (con tolerancia)?
 * La frontera es un caso de negocio real: una dirección justo en el límite de
 * la zona debe resolverse de forma determinista, no al azar del redondeo.
 */
function onSegment(
  point: Position,
  a: Position,
  b: Position,
  epsilon: number,
): boolean {
  const [px, py] = point;
  const [ax, ay] = a;
  const [bx, by] = b;

  // Producto cruzado ~ 0 => colineal.
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > epsilon) return false;

  // Y dentro del rectángulo del segmento => está entre a y b.
  return (
    Math.min(ax, bx) - epsilon <= px &&
    px <= Math.max(ax, bx) + epsilon &&
    Math.min(ay, by) - epsilon <= py &&
    py <= Math.max(ay, by) + epsilon
  );
}

/** ¿El punto cae sobre el borde del polígono? */
export function isOnBoundary(
  point: Position,
  ring: Ring,
  epsilon = BOUNDARY_EPSILON,
): boolean {
  assertRing(ring);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (onSegment(point, ring[j]!, ring[i]!, epsilon)) return true;
  }
  return false;
}

/**
 * ¿El punto está dentro del polígono? Algoritmo de cruce de rayos.
 *
 * **La frontera cuenta como DENTRO** (`includeBoundary`, por defecto `true`).
 * Es una decisión de negocio, no matemática: al cliente cuya dirección cae
 * justo en el límite se le da servicio. Sin esta regla explícita, el resultado
 * dependería del error de punto flotante y sería irreproducible.
 */
export function isPointInPolygon(
  point: Position,
  ring: Ring,
  options: { includeBoundary?: boolean; epsilon?: number } = {},
): boolean {
  assertRing(ring);
  const includeBoundary = options.includeBoundary ?? true;
  const epsilon = options.epsilon ?? BOUNDARY_EPSILON;

  if (isOnBoundary(point, ring, epsilon)) {
    return includeBoundary;
  }

  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    // ¿El rayo horizontal hacia +infinito cruza este lado?
    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------- Zonas

/** Zona de cobertura evaluable. Los montos van como enteros de céntimos. */
export interface CoverageZone<TId = string> {
  readonly id: TId;
  readonly polygon: Ring;
  /** Tarifa de envío en unidades menores (ver Money). */
  readonly deliveryFeeMinor: number;
  /** Pedido mínimo en unidades menores. */
  readonly minOrderMinor: number;
  /** Tiempo base de entrega en minutos. */
  readonly baseMinutes: number;
  readonly active?: boolean;
}

/**
 * Selecciona la zona aplicable a un punto (RN-ORG-02).
 *
 * El solapamiento está permitido: **gana la de menor tarifa**. Los empates se
 * rompen de forma determinista (menor pedido mínimo, luego menor tiempo base,
 * luego id) para que dos llamadas idénticas nunca devuelvan zonas distintas:
 * un precio de envío que cambia entre la tienda y la confirmación es un
 * problema de confianza, no un detalle.
 *
 * Devuelve `undefined` si ninguna zona activa cubre el punto (→ 404 en la API).
 */
export function selectCoverageZone<TId>(
  point: Position,
  zones: readonly CoverageZone<TId>[],
): CoverageZone<TId> | undefined {
  const matches = zones.filter((z) => {
    if (z.active === false) return false;
    // Descarte barato antes del cálculo completo. La tolerancia debe ser la
    // misma que usa la frontera: si no, este filtro descartaría puntos que
    // isPointInPolygon sí aceptaría.
    if (!inBoundingBox(point, boundingBox(z.polygon), BOUNDARY_EPSILON)) {
      return false;
    }
    return isPointInPolygon(point, z.polygon);
  });

  if (matches.length === 0) return undefined;

  return matches.reduce((best, candidate) => {
    if (candidate.deliveryFeeMinor !== best.deliveryFeeMinor) {
      return candidate.deliveryFeeMinor < best.deliveryFeeMinor
        ? candidate
        : best;
    }
    if (candidate.minOrderMinor !== best.minOrderMinor) {
      return candidate.minOrderMinor < best.minOrderMinor ? candidate : best;
    }
    if (candidate.baseMinutes !== best.baseMinutes) {
      return candidate.baseMinutes < best.baseMinutes ? candidate : best;
    }
    return String(candidate.id) < String(best.id) ? candidate : best;
  });
}
