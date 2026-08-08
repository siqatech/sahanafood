import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import {
  BASE_URL,
  PEAK_RPS,
  SUSTAINED_RPS,
  PEAK_DURATION,
  RAMP_DURATION,
  THRESHOLDS,
  requestParams,
  loadScenario,
} from './lib/config.js';

/**
 * Pico de almuerzo: 10× el throughput de diseño durante 15 minutos (T4.30).
 *
 * Es la prueba que dice si el sistema aguanta un viernes. El perfil sale de
 * docs/06 (2 000 pedidos/hora sostenidos, pico 10× por 15 min) y el gate es
 * doble:
 *
 * · **p95 de submit < 500 ms.** Un cajero esperando medio segundo con el
 *   cliente delante ya es incómodo; un segundo y medio es una cola.
 * · **CERO pérdida.** Todo pedido con 201 tiene que existir en la base y tener
 *   su evento en el outbox. Eso NO se comprueba aquí —k6 no habla con
 *   Postgres— sino en `verify-zero-loss.mjs`, que corre después. Separarlo es
 *   deliberado: la prueba de carga mide, la verificación juzga.
 *
 * Cada pedido lleva su `Idempotency-Key`. No es decoración: bajo carga los
 * reintentos existen, y sin la clave un timeout del cliente que reintenta
 * crearía pedidos duplicados que luego se contarían como «pérdida negativa».
 */

const pedidosCreados = new Counter('pedidos_creados');
const pedidosRechazados = new Counter('pedidos_rechazados');
const renovacionesToken = new Counter('renovaciones_token');
const latenciaSubmit = new Trend('latencia_submit', true);

/**
 * Token POR VU, con su caducidad.
 *
 * El de `setup()` no vale para toda la prueba: dura 900 s (15 min) y el pico
 * dura 15 min más el calentamiento. La primera corrida perdió los últimos 60
 * segundos con 403 — 335 pedidos de 5 045— y el fallo parecía del servidor
 * cuando era del generador. Un cliente real renueva; este también.
 */
let tokenVU = null;
let tokenExpiraEn = 0;
/** Se renueva ANTES de caducar: apurar el último minuto es pedir el fallo. */
const MARGEN_RENOVACION_MS = 120000;
/** Contador local: los `Counter` de k6 no exponen su valor para leerlo. */
let fallosImpresos = 0;

export const options = {
  scenarios: {
    // Calentamiento: llena el pool de conexiones y los planes de consulta.
    // Sin esto, el primer minuto mediría el arranque en frío y contaminaría
    // el p95 de toda la prueba.
    calentamiento: {
      executor: 'constant-arrival-rate',
      rate: Math.ceil(SUSTAINED_RPS * 60),
      timeUnit: '1m',
      duration: RAMP_DURATION,
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: 'submitOrder',
      tags: { fase: 'calentamiento' },
    },
    // EL pico. Tasa de llegada constante: si la API se pone lenta, la carga
    // entra igual — que es lo que hace un almuerzo de viernes.
    pico: {
      executor: 'constant-arrival-rate',
      rate: Math.ceil(PEAK_RPS * 60),
      timeUnit: '1m',
      duration: PEAK_DURATION,
      startTime: RAMP_DURATION,
      preAllocatedVUs: 50,
      maxVUs: 300,
      exec: 'submitOrder',
      tags: { fase: 'pico' },
    },
  },
  thresholds: THRESHOLDS,
  // Sin resumen por defecto en stdout: lo escribe `handleSummary` en JSON para
  // que la verificación posterior lo lea sin parsear texto de consola.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const escenario = loadScenario();

export function setup() {
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: escenario.email, password: escenario.password }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (res.status !== 201) {
    throw new Error(
      `No se pudo autenticar el generador de carga: ${res.status} ${res.body}`,
    );
  }
  return {
    token: res.json('accessToken'),
    ttlMs: (res.json('expiresIn') || 900) * 1000,
    emitidoEn: Date.now(),
  };
}

/** Devuelve un token vivo, renovándolo si le queda poco. */
function tokenVigente(inicial) {
  const ahora = Date.now();
  if (tokenVU && ahora < tokenExpiraEn - MARGEN_RENOVACION_MS) return tokenVU;

  // El primer uso aprovecha el token de `setup()`; a partir de ahí, login.
  if (!tokenVU && inicial) {
    tokenVU = inicial.token;
    tokenExpiraEn = inicial.emitidoEn + inicial.ttlMs;
    if (ahora < tokenExpiraEn - MARGEN_RENOVACION_MS) return tokenVU;
  }

  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: escenario.email, password: escenario.password }),
    {
      headers: { 'content-type': 'application/json' },
      tags: { operacion: 'login' },
    },
  );
  if (res.status !== 201) {
    throw new Error(`No se pudo renovar el token: ${res.status}`);
  }
  tokenVU = res.json('accessToken');
  const ttl = res.json('expiresIn');
  tokenExpiraEn = Date.now() + (typeof ttl === 'number' ? ttl : 900) * 1000;
  renovacionesToken.add(1);
  return tokenVU;
}

export function submitOrder(data) {
  const clave = `carga-${__VU}-${__ITER}-${Date.now()}`;
  const token = tokenVigente(data);

  const res = http.post(
    `${BASE_URL}/api/v1/orders`,
    JSON.stringify({
      brandId: escenario.brandId,
      locationId: escenario.locationId,
      channel: 'pos',
      lines: [
        {
          productId: escenario.productId,
          // Cantidad variable: un pedido de 3 unidades pasa por el mismo
          // camino que uno de 1, pero calcula más y escribe más líneas.
          quantity: (__ITER % 3) + 1,
          modifierOptionIds: [escenario.modifierOptionId],
        },
      ],
    }),
    requestParams(token, 'submit', { 'idempotency-key': clave }),
  );

  latenciaSubmit.add(res.timings.duration);

  const ok = check(
    res,
    {
      'submit devuelve 201': (r) => r.status === 201,
      'el pedido trae id': (r) => Boolean(r.json('id')),
    },
    { operacion: 'submit' },
  );

  if (ok) pedidosCreados.add(1);
  else {
    pedidosRechazados.add(1);
    // Se imprime el primer puñado de fallos: en una prueba de 5 000 pedidos,
    // saber QUÉ falló vale más que saber cuántos.
    // Contador local: `Counter.value` no existe en k6, así que el diagnóstico
    // de la primera versión NUNCA llegó a imprimirse — y sin él hubo que
    // deducir el motivo del fallo por aritmética.
    if (fallosImpresos < 5) {
      fallosImpresos++;
      console.error(
        `submit falló: ${res.status} ${String(res.body).slice(0, 300)}`,
      );
    }
  }
}

/**
 * Deja el resumen en JSON para que `verify-zero-loss.mjs` lo lea.
 *
 * La verificación necesita saber CUÁNTOS pedidos dijo k6 haber creado, para
 * compararlo con lo que hay en la base. Parsear la salida de consola sería
 * frágil; un fichero JSON no.
 */
export function handleSummary(data) {
  // Ruta RELATIVA al guion: k6 corre con el cwd en `tests/load`, dentro del
  // contenedor. Una ruta desde la raíz del repo escribiría en un sitio que
  // dentro del contenedor no existe, y el resumen se perdería en silencio.
  return {
    'results/submit-orders.json': JSON.stringify(data, null, 2),
    stdout: resumenLegible(data),
  };
}

function valor(metricas, nombre, campo) {
  const m = metricas[nombre];
  if (!m || !m.values) return 0;
  const v = m.values[campo];
  return typeof v === 'number' ? v : 0;
}

function resumenLegible(data) {
  const m = data.metrics;
  const creados = valor(m, 'pedidos_creados', 'count');
  const rechazados = valor(m, 'pedidos_rechazados', 'count');
  const p95 = valor(m, 'http_req_duration{operacion:submit}', 'p(95)');
  const abandonadas = valor(m, 'dropped_iterations', 'count');

  return [
    '',
    '=== Pico de almuerzo (T4.30) ===',
    `  Pedidos creados:      ${creados}`,
    `  Pedidos rechazados:   ${rechazados}`,
    `  Iteraciones perdidas: ${abandonadas}${abandonadas > 0 ? '  ← el generador NO metió toda la carga' : ''}`,
    `  p95 de submit:        ${p95 ? p95.toFixed(1) + ' ms' : 'sin datos'} (gate < 500 ms)`,
    `  Renovaciones de token: ${valor(m, 'renovaciones_token', 'count')}`,
    '',
    '  Falta comprobar la CERO PÉRDIDA contra la base:',
    '    node tests/load/verify-zero-loss.mjs',
    '',
  ].join('\n');
}
