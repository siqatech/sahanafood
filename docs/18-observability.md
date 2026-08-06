# Observabilidad

- OpenTelemetry en API, workers y print-agent (métricas locales). Trazas con `trace_id` propagado desde el borde hasta colas (atributos: tenant_id, order_id, channel).
- Logs estructurados JSON: SIEMPRE tenant_id + trace_id; order_id cuando aplique. Sin datos personales en logs.
- Métricas de negocio (Prometheus): pedidos/min por canal · tiempo hasta aceptación · tiempo cocina p95 · profundidad de colas y DLQ · tasa de error por conector · mensajes WhatsApp por pedido · documentos SUNAT pendientes · POS offline activos · diferencia de arqueo.
- Alertas por síntoma (no por CPU): caída de pedidos vs misma hora semana anterior > 50% · DLQ critical > 0 (5 min) · webhook error rate > 5% · documentos encolados > umbral · pedido sin transición > 10 min.
- **Trazabilidad del pedido:** vista de soporte "¿dónde está el pedido X?" que reconstruye la línea de tiempo desde `ord_order_events` + trazas: canal origen, dedupe, aceptación, tickets, stock, pago, documento, entrega, reintentos de integración.
- Paneles: operación por tenant (para soporte), salud de plataforma, salud por conector, costo WhatsApp.
- Sentry para errores de frontend/PWA/print-agent con sourcemaps.
