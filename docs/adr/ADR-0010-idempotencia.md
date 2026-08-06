# ADR-0010 — Idempotencia y deduplicación

Estado: Propuesto · Fecha: 2026-08-05

## Decisión
1. **Pedidos externos:** UNIQUE `(tenant_id, channel, external_ref)` en ord_orders. Reintento del proveedor → 200 con el pedido existente (nunca 409 al proveedor).
2. **Clientes propios (tienda, POS, apps):** header `Idempotency-Key` (ULID generado en cliente) obligatorio en POST de pedido y pago. Tabla `ord_idempotency_keys` guarda hash del payload + respuesta; misma clave+mismo payload → respuesta cacheada; misma clave+payload distinto → 422. TTL 48 h.
3. **POS offline:** el ULID del pedido se genera en el cliente y ES la clave: la sincronización repetida es naturalmente idempotente.
4. **Eventos:** inbox por consumidor (ADR-0007).
5. **Webhooks entrantes:** dedupe `(provider, event_id)` + firma + timestamp ±5 min.
6. **Reintentos salientes:** solo sobre operaciones idempotentes del proveedor; backoff exponencial + jitter; presupuesto de reintentos por operación; luego DLQ.
