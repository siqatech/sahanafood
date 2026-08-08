/**
 * Perfil de carga y umbrales (T4.30).
 *
 * Los números NO son inventados: salen de docs/06.
 *
 *   «Throughput de diseño: 2 000 pedidos/hora sostenidos, pico 10× por 15 min»
 *   «p95 de submit < 500 ms»
 *
 * 2 000 pedidos/hora sostenidos = 0,556 pedidos/s.
 * Pico 10× = 5,56 pedidos/s durante 15 minutos.
 *
 * Se expresa en `constant-arrival-rate` y no en usuarios virtuales a propósito.
 * Con VUs, si la API se pone lenta el generador manda MENOS carga —los usuarios
 * esperan— y la prueba se vuelve más suave justo cuando debería apretar. Con
 * tasa de llegada constante, la carga entra pase lo que pase: que es lo que
 * hace un almuerzo de viernes.
 */

/** Pedidos por segundo en el pico (10× el sostenido de docs/06). */
export const PEAK_RPS = 5.56;
export const SUSTAINED_RPS = 0.556;

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

/**
 * Duración del pico. La spec pide 15 minutos y ese es el valor por defecto;
 * se puede acortar con `PEAK_DURATION` para iterar sin esperar un cuarto de
 * hora en cada cambio.
 */
export const PEAK_DURATION = __ENV.PEAK_DURATION || '15m';
export const RAMP_DURATION = __ENV.RAMP_DURATION || '1m';

/**
 * Umbrales. Son la CONDICIÓN DE FALLO de la prueba, no adorno: k6 sale con
 * código ≠ 0 si no se cumplen, y por eso esto puede correr en CI.
 */
export const THRESHOLDS = {
  // El gate de la spec. Se mide sobre el submit y no sobre «todas las
  // peticiones»: mezclar el login en la media escondería justo lo que importa.
  'http_req_duration{operacion:submit}': ['p(95)<500'],
  // Sin errores. Un 5xx durante el pico es un pedido perdido, y la spec pide
  // CERO pérdida: no hay margen que negociar aquí.
  'http_req_failed{operacion:submit}': ['rate==0'],
  // Que k6 haya logrado meter la carga. Si abandona peticiones por falta de
  // VUs, la prueba no midió el pico: midió otra cosa más suave.
  dropped_iterations: ['count==0'],
  pedidos_creados: ['count>0'],
};

/**
 * Parámetros HTTP con el token.
 *
 * Sin spread de objetos ni encadenamiento opcional en TODO este directorio: el
 * intérprete de k6 lleva un Babel antiguo que no los admite, y el error que da
 * es un `SyntaxError` con doscientas líneas de traza de Babel que no dice cuál
 * es el problema real.
 */
export function requestParams(token, operacion, extraHeaders) {
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  if (extraHeaders) {
    for (const clave in extraHeaders) headers[clave] = extraHeaders[clave];
  }
  return { headers: headers, tags: { operacion: operacion } };
}

/** Lee el escenario que dejó `pnpm --filter @sahana/api seed:load`. */
export function loadScenario() {
  const crudo = __ENV.SCENARIO;
  if (!crudo) {
    throw new Error(
      'Falta SCENARIO. Ejecuta antes: make load-seed (deja el JSON del escenario).',
    );
  }
  return JSON.parse(crudo);
}
