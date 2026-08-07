import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Métricas Prometheus (T3.14).
 *
 * Criterio de selección: no se instrumenta "todo por si acaso", sino aquello
 * cuyo deterioro cuesta dinero o rompe un SLO declarado en docs/06:
 *
 *  · p95 < 500 ms en transiciones de pedido       → histograma de latencia
 *  · pedido visible en KDS < 5 s                  → retraso del outbox
 *  · outbox sin publicar > 1 000 → ALERTA         → gauge de pendientes (ADR-0007)
 *  · fuerza bruta de PIN y reuso de refresh       → contadores de seguridad
 *
 * Todas las métricas de negocio llevan la etiqueta `tenant` SOLO cuando su
 * cardinalidad está acotada; para las de alta cardinalidad se omite a
 * propósito: una etiqueta por tenant en un histograma multiplica las series
 * temporales y termina tumbando al propio Prometheus.
 */

export const registry = new Registry();

registry.setDefaultLabels({ service: 'sahana-api' });
collectDefaultMetrics({ register: registry });

// --------------------------------------------------------------- HTTP

export const httpRequestDuration = new Histogram({
  name: 'sahana_http_request_duration_seconds',
  help: 'Duración de las peticiones HTTP en segundos',
  // Sin etiqueta de tenant: sería de cardinalidad ilimitada.
  labelNames: ['method', 'route', 'status'] as const,
  // Cubos alineados con el SLO de 500 ms: hay resolución alrededor del objetivo.
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: 'sahana_http_requests_total',
  help: 'Total de peticiones HTTP atendidas',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

// ------------------------------------------------------- Outbox (ADR-0007)

/**
 * Eventos pendientes de publicar. Es la métrica de salud MÁS importante del
 * sistema asíncrono: si sube y no baja, la cocina deja de enterarse de los
 * pedidos. Umbral de alerta documentado: > 1 000.
 */
export const outboxPending = new Gauge({
  name: 'sahana_outbox_pending',
  help: 'Eventos en el outbox pendientes de publicar',
  registers: [registry],
});

export const outboxPublished = new Counter({
  name: 'sahana_outbox_published_total',
  help: 'Eventos publicados por el relay',
  labelNames: ['event_type'] as const,
  registers: [registry],
});

export const outboxRelayErrors = new Counter({
  name: 'sahana_outbox_relay_errors_total',
  help: 'Fallos del relay al publicar',
  registers: [registry],
});

/**
 * Antigüedad del evento pendiente más viejo. Complementa al contador: 10
 * eventos atascados desde hace una hora son peor síntoma que 500 recién
 * llegados.
 */
export const outboxOldestPendingSeconds = new Gauge({
  name: 'sahana_outbox_oldest_pending_seconds',
  help: 'Antigüedad en segundos del evento pendiente más antiguo',
  registers: [registry],
});

// ------------------------------------------------------------ Seguridad

export const authLoginAttempts = new Counter({
  name: 'sahana_auth_login_attempts_total',
  help: 'Intentos de inicio de sesión',
  labelNames: ['result'] as const, // success | failure
  registers: [registry],
});

/** Reuso de refresh token: señal de robo de credenciales (RN-IDN-02). */
export const refreshReuseDetected = new Counter({
  name: 'sahana_auth_refresh_reuse_total',
  help: 'Reutilizaciones de refresh token detectadas (familia revocada)',
  registers: [registry],
});

/** Bloqueos de PIN: un pico indica fuerza bruta en un local (RN-IDN-03). */
export const pinLockouts = new Counter({
  name: 'sahana_auth_pin_lockouts_total',
  help: 'PIN de operador bloqueados por intentos fallidos',
  registers: [registry],
});

// ------------------------------------------------------------ Tenancy

export const tenantLimitExceeded = new Counter({
  name: 'sahana_tenant_limit_exceeded_total',
  help: 'Rechazos por límite de plan alcanzado',
  labelNames: ['resource'] as const,
  registers: [registry],
});

// ------------------------------------------------------- Integraciones

/**
 * Ingesta de marketplaces. La etiqueta es el PROVEEDOR, no el tenant: el número
 * de proveedores está acotado (son integraciones que se certifican una a una),
 * así que la cardinalidad no se dispara, y cuando algo se rompe lo hace por
 * proveedor —un cambio de formato de Rappi afecta a todos sus tenants a la vez.
 */
export const webhooksReceived = new Counter({
  name: 'sahana_webhooks_received_total',
  help: 'Webhooks de integración recibidos con conexión válida',
  labelNames: ['provider'] as const,
  registers: [registry],
});

export const webhooksRejected = new Counter({
  name: 'sahana_webhooks_rejected_total',
  help: 'Webhooks rechazados sin encolar (firma inválida, conexión pausada)',
  labelNames: ['provider', 'reason'] as const,
  registers: [registry],
});

/**
 * Desenlace de cada envío procesado. `outcome=needs_review` subiendo significa
 * que el mapeo de catálogo se rompió: el canal sigue vendiendo algo que no
 * sabemos preparar, y eso se paga en cancelaciones.
 */
export const webhooksProcessed = new Counter({
  name: 'sahana_webhooks_processed_total',
  help: 'Webhooks procesados por desenlace',
  labelNames: ['provider', 'outcome'] as const, // order | needs_review | failed
  registers: [registry],
});

/** Devuelve las métricas en formato de exposición Prometheus. */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const METRICS_CONTENT_TYPE = registry.contentType;
