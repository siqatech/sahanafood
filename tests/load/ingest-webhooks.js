import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import {
  BASE_URL,
  PEAK_RPS,
  PEAK_DURATION,
  loadScenario,
} from './lib/config.js';

/**
 * Ingesta desde marketplace bajo carga (T4.30, docs/15).
 *
 * Complementa a `submit-orders.js` porque el camino es distinto y falla
 * distinto: aquí el pedido entra por un webhook firmado, tiene que quedar
 * guardado ANTES de procesarse (RN-INT-02) y el ack debe salir en menos de
 * 250 ms — el marketplace reintenta o marca el canal como caído si tardamos.
 *
 * Ese ack rápido es justamente lo que hace peligroso el camino: responder
 * pronto y procesar después solo es seguro si lo recibido se persiste primero.
 * T4.15 ya lo probó matando el worker; esto lo prueba con volumen, que es la
 * otra forma de perder cosas.
 *
 * El payload y la cabecera de firma son los del CONECTOR DEL SIMULADOR
 * (`simulator.connector.ts`), no una invención: `order_id`, `items[].sku`,
 * `qty`, céntimos, y el HMAC en hexadecimal PELADO. Una primera versión de este
 * guion mandaba camelCase y `sha256=<hmac>`; habría medido cinco mil rechazos
 * por firma inválida —rapidísimos— y dado un p95 excelente de nada.
 */

const acks = new Counter('webhooks_aceptados');
const fallos = new Counter('webhooks_fallidos');
/** Contador local: los `Counter` de k6 no exponen su valor para leerlo. */
let fallosImpresos = 0;

export const options = {
  scenarios: {
    ingesta: {
      executor: 'constant-arrival-rate',
      rate: Math.ceil(PEAK_RPS * 60),
      timeUnit: '1m',
      duration: PEAK_DURATION,
      preAllocatedVUs: 50,
      maxVUs: 300,
      tags: { operacion: 'webhook' },
    },
  },
  thresholds: {
    // 250 ms es el compromiso con el marketplace, no una preferencia nuestra.
    'http_req_duration{operacion:webhook}': ['p(95)<250'],
    'http_req_failed{operacion:webhook}': ['rate==0'],
    dropped_iterations: ['count==0'],
    webhooks_aceptados: ['count>0'],
  },
};

const escenario = loadScenario();

export function setup() {
  if (!escenario.webhookToken || !escenario.signingSecret) {
    throw new Error(
      'El escenario no trae webhookToken/signingSecret. Vuelve a sembrar: make load-seed',
    );
  }
  return {};
}

export default function () {
  // `order_id` único por iteración: es la clave de dedupe
  // `(tenant, canal, external_id)`. Repetirlo mediría el camino del duplicado,
  // que es rápido y falsearía el percentil hacia abajo.
  const orderId = `carga-${__VU}-${__ITER}-${Date.now()}`;
  const cuerpo = JSON.stringify({
    event: 'order.created',
    order_id: orderId,
    placed_at: new Date().toISOString(),
    customer: { name: 'Cliente de carga', phone: '+51999000111' },
    // La opción va SIEMPRE: el producto tiene un grupo obligatorio («Tamaño»,
    // mínimo 1) y sin ella el pedido se rechaza. Un guion que manda pedidos
    // inválidos mide el camino del rechazo, que es corto, y da un p95 magnífico
    // de nada.
    items: [
      {
        sku: escenario.externalSku,
        qty: (__ITER % 3) + 1,
        options: [escenario.externalOptionSku],
      },
    ],
    total_cents: 3800,
  });

  // La firma va sobre el cuerpo CRUDO, igual que en producción: firmar sobre
  // el objeto reserializado daría un HMAC distinto y probaría otra cosa.
  const firma = crypto.hmac('sha256', escenario.signingSecret, cuerpo, 'hex');

  const res = http.post(
    `${BASE_URL}/api/v1/integrations/webhooks/${escenario.webhookToken}`,
    cuerpo,
    {
      headers: {
        'content-type': 'application/json',
        'x-sahana-signature': firma,
        'x-sahana-delivery-id': orderId,
      },
      tags: { operacion: 'webhook' },
    },
  );

  const ok = check(res, {
    'el webhook se acepta': (r) => r.status === 202 || r.status === 200,
  });
  if (ok) acks.add(1);
  else {
    fallos.add(1);
    if (fallosImpresos < 5) {
      fallosImpresos++;
      console.error(
        `webhook falló: ${res.status} ${String(res.body).slice(0, 300)}`,
      );
    }
  }
}

function valor(metricas, nombre, campo) {
  const m = metricas[nombre];
  if (!m || !m.values) return 0;
  const v = m.values[campo];
  return typeof v === 'number' ? v : 0;
}

export function handleSummary(data) {
  const aceptados = valor(data.metrics, 'webhooks_aceptados', 'count');
  const fallidos = valor(data.metrics, 'webhooks_fallidos', 'count');
  const p95 = valor(
    data.metrics,
    'http_req_duration{operacion:webhook}',
    'p(95)',
  );

  return {
    'results/ingest-webhooks.json': JSON.stringify(data, null, 2),
    stdout: [
      '',
      '=== Ingesta de marketplace ===',
      '  Aceptados: ' + aceptados,
      '  Fallidos:  ' + fallidos,
      '  p95 ack:   ' + p95.toFixed(1) + ' ms (gate < 250 ms)',
      '',
      '  Falta comprobar que lo aceptado se convirtió en pedidos:',
      '    make load-verify',
      '',
    ].join('\n'),
  };
}
