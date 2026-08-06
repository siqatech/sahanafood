# Eventos y webhooks

## Patrón obligatorio (ADR-0007)
Escritura de dominio + INSERT en `outbox` en la MISMA transacción → relay (worker) publica a BullMQ → consumidor verifica `inbox` antes de procesar → marca procesado en la misma transacción de su efecto.

## Catálogo de eventos de dominio (v1)
Formato: CloudEvents-like `{id ulid, type, tenant_id, aggregate_id, occurred_at, data, schema_version}`.

| Evento | Emisor | Consumidores |
|---|---|---|
| order.received | Ordering | Kitchen (pre-alerta), Analytics |
| order.accepted | Ordering | Kitchen (crear tickets), Inventory (consumo), Billing (preparar doc), Notifications |
| order.rejected / order.cancelled | Ordering | Inventory (reversa si consumió), Billing (NC si facturado), Notifications, Integrations (notificar canal) |
| order.modified | Ordering | Kitchen, Billing (línea de ajuste) |
| kitchen.ticket_ready | Kitchen | Ordering (avanzar estado si todas listas) |
| kitchen.saturated / kitchen.recovered | Kitchen | Catalog (pausar/reanudar canal), Integrations |
| order.packed | Kitchen | Delivery |
| delivery.assigned / delivery.delivered / delivery.failed | Delivery | Ordering, Notifications, CRM |
| payment.confirmed / payment.failed | Payments | Ordering, Billing |
| document.issued / document.rejected | Billing | Ordering, alertas |
| stock.below_minimum / stock.negative | Inventory | Alertas, Catalog (opcional autopausa) |
| catalog.availability_changed | Catalog | Integrations (propagar a canales) |

Regla: los consumidores son idempotentes y tolerantes a desorden (comparar `occurred_at`/versión antes de aplicar).

## Colas BullMQ
`critical` (transiciones de pedido, pagos) · `integrations` (ingesta/propagación externa) · `documents` (OSE) · `notifications` · `reports` (CPU). DLQ por cola con panel de reproceso manual; alerta si DLQ > 0 por 5 min en `critical`.
