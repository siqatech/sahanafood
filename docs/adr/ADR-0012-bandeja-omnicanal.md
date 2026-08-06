# ADR-0012 — Bandeja omnicanal propia (no Chatwoot embebido)

Estado: Propuesto · Fecha: 2026-08-06

## Contexto
La derivación humana necesita una bandeja (inbox). Opciones: embeber/integrar Chatwoot (MIT) o construir una bandeja propia enfocada en pedidos.

## Decisión
**Bandeja propia, acotada y centrada en el pedido.** Razones: (1) la conversación de un restaurante ES el pedido — la bandeja debe mostrar carrito en curso, historial de compras, botones "crear pedido", "enviar link de pago", "enviar tracking", cosa que en Chatwoot exigiría plugins profundos; (2) evitar un segundo sistema con su propia base de usuarios, permisos y multi-tenancy que habría que sincronizar; (3) el modelo de datos conversacional es simple (conversación, mensaje, asignación, etiqueta, nota) comparado con el costo de integración. Chatwoot queda como referencia de UX (clasificación Referenciar, ADR-0009).

## Alcance propio vs no propio
Propio: WhatsApp (Cloud API), chat web de la tienda, y correo entrante básico (v2). NO propio: Instagram/Messenger/TikTok quedan para conectores futuros sobre la misma bandeja (la entidad Conversación ya nace con `channel` abierto).

## Consecuencias
+ Bandeja nativa del dominio, un solo RBAC, la IA y el humano comparten contexto completo. − Construimos funciones que Chatwoot regala (búsqueda, atajos, vistas); se acota a lo esencial de operación y se resiste el scope creep de "help desk genérico".
