# ADR-0007 — Outbox/Inbox transaccional para eventos

Estado: Propuesto · Fecha: 2026-08-05

## Contexto
El plan original publicaba eventos a la cola tras el commit. Entre el commit y la publicación el proceso puede morir: se pierde el evento (cocina no se entera del pedido). Inaceptable en el flujo crítico.

## Decisión
1. Todo evento de dominio se INSERTa en `outbox` EN LA MISMA transacción que el cambio de estado.
2. Un relay (worker con FOR UPDATE SKIP LOCKED, lote 100, intervalo 250 ms) publica a BullMQ y marca `published_at`. At-least-once garantizado.
3. Todo consumidor verifica `inbox (consumer, event_id)` y registra el procesamiento en la MISMA transacción de su efecto → exactamente-una-vez efectivo.
4. El outbox es la fuente de verdad de publicación: ante pérdida de Redis se re-publica lo no confirmado.
5. Limpieza: outbox publicado > 7 días → archivo; inbox > 30 días → borrado.

## Alternativas
Publicación directa post-commit (rechazado: pérdida), CDC/Debezium (rechazado MVP: infraestructura Kafka que no queremos), transacciones distribuidas (rechazado: complejidad).

## Consecuencias
+ Sin pérdida ni duplicado efectivo; auditable; reproducible. − Latencia extra ~250–500 ms en la reacción (aceptable: SLO KDS < 5 s); dos tablas más y un relay que monitorear (métrica: outbox no publicado > 1 000 → alerta).
