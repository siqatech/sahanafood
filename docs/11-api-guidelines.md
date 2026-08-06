# Convenciones de API

- REST, `/api/v1`, JSON. Versionado por URL; cambios incompatibles → v2, nunca romper v1.
- Autenticación: JWT corto (15 min) + refresh rotativo. POS: sesión de dispositivo + PIN de operador por acción sensible.
- IDs públicos: ULID. Nunca secuenciales.
- Paginación por cursor (`?after=<ulid>&limit=`). Filtros documentados por recurso.
- Errores: RFC 9457 Problem Details. Catálogo de códigos en `packages/contracts/errors.ts`. Formato: `{type, title, status, code, detail, trace_id}`.
- Idempotencia: header `Idempotency-Key` (ULID) obligatorio en `POST /orders` y `POST /payments`. Respuesta cacheada 48 h; conflicto de payload distinto con misma clave → 422 `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- Concurrencia: `If-Match` con `row_version` en PATCH de catálogo y pedidos → 409 si difiere.
- Rate limiting: por tenant y por IP (ver docs/14). 429 con `Retry-After`.
- Webhooks salientes: firma HMAC-SHA256 en header `X-Sahana-Signature`, timestamp anti-replay (±5 min), reintentos con backoff exponencial + jitter (1m, 5m, 30m, 2h, 12h) → DLQ + panel.
- Todas las respuestas incluyen `trace_id` (correlación con OTel).
