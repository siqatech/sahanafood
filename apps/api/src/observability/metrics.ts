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

// ------------------------------------------------------------- Worker

/**
 * Salud de los procesos de fondo. Es lo único que distingue «no hay trabajo
 * pendiente» de «el worker lleva horas muerto»: sin estas series, un worker
 * caído se ve exactamente igual que uno ocioso hasta que la cocina pregunta
 * por qué no entran pedidos.
 *
 * La alerta útil no es sobre los errores, es sobre la AUSENCIA: si
 * `sahana_worker_runs_total` deja de crecer, el worker no está corriendo.
 */
export const workerRunsTotal = new Counter({
  name: 'sahana_worker_runs_total',
  help: 'Vueltas completadas por cada trabajo periódico',
  labelNames: ['job', 'result'] as const, // ok | error
  registers: [registry],
});

export const workerRunErrors = new Counter({
  name: 'sahana_worker_run_errors_total',
  help: 'Vueltas fallidas por trabajo',
  labelNames: ['job'] as const,
  registers: [registry],
});

export const workerRunDuration = new Histogram({
  name: 'sahana_worker_run_duration_seconds',
  help: 'Duración de cada vuelta del trabajo periódico',
  labelNames: ['job'] as const,
  // Hasta 60 s: una vuelta más larga que su intervalo es la señal de que hay
  // que subir el intervalo o repartir el trabajo.
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60],
  registers: [registry],
});

// ------------------------------------------------ Consumo de eventos

/**
 * Consumo del inbox. `outcome=skipped` NO es un fallo: es una entrega repetida
 * correctamente descartada, y verla subir confirma que el exactamente-una-vez
 * está trabajando. Lo preocupante es que `processed` se estanque mientras el
 * outbox crece: eso significa que los eventos salen pero nadie los aplica.
 */
export const eventsConsumed = new Counter({
  name: 'sahana_events_consumed_total',
  help: 'Eventos de dominio consumidos, por desenlace',
  labelNames: ['consumer', 'event_type', 'outcome'] as const,
  registers: [registry],
});

export const eventsConsumeErrors = new Counter({
  name: 'sahana_events_consume_errors_total',
  help: 'Fallos al consumir eventos de dominio',
  labelNames: ['consumer', 'event_type'] as const,
  registers: [registry],
});

/**
 * Latencia de aceptado → visible en cocina. Es el SLO de la spec 07 (< 5 s) y
 * la única métrica que dice si el KDS sirve: un pedido que tarda medio minuto
 * en aparecer ya salió tarde aunque todo lo demás esté verde.
 */
export const kitchenTicketLatency = new Histogram({
  name: 'sahana_kitchen_ticket_latency_seconds',
  help: 'Segundos entre aceptar el pedido y tener su ticket en cocina',
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
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
