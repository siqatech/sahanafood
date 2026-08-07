-- 0007 — Correlación de trazas en el outbox (T3.14).
--
-- Sin esto la traza se corta en la cola: el worker procesa el evento en otro
-- proceso y minutos más tarde, así que la propagación automática de contexto de
-- OpenTelemetry no lo alcanza. Guardar el trace_id del request que originó el
-- evento permite responder la pregunta que de verdad importa en producción:
-- «¿por qué este pedido no llegó a la cocina?», siguiendo la cadena completa
-- request → outbox → worker.
ALTER TABLE outbox ADD COLUMN trace_id text;

-- Índice para localizar todos los eventos de una traza durante un diagnóstico.
CREATE INDEX idx_outbox_trace ON outbox (trace_id) WHERE trace_id IS NOT NULL;
