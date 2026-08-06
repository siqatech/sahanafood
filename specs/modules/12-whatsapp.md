# Módulo: WhatsApp
> Fase: 4 (notificaciones) / 5 (bot) · Depende de: Ordering, Catalog

## Alcance
F4: notificaciones de estado por plantillas aprobadas (aceptado, en preparación, en camino, entregado). F5: bot de toma de pedido (listas/botones interactivos, mínimos turnos), enlace a vista web para carritos complejos, derivación a humano con contexto (evaluar Chatwoot como servicio), consentimiento y ventanas.
## Reglas
RN-WA-01 Diseño por costo: KPI mensajes/pedido con presupuesto (objetivo ≤ 8 en F5); recordar cambio de precios Meta 01-10-2026 (mensajes de servicio cobrados). RN-WA-02 Solo plantillas aprobadas fuera de ventana de 24 h; utility para estados de pedido. RN-WA-03 Derivación humana: transcript completo + pedido en curso visibles para el agente. RN-WA-04 Opt-out inmediato y persistente (RN-T10). RN-WA-05 Webhook Meta: firma + dedupe por message_id (inbox).
## Pruebas
Ventana expirada → usa plantilla · opt-out respetado en campañas · dedupe de webhook · caída de WhatsApp → fallback (email/SMS si hay dato) y el pedido sigue.
## Aceptación
Pedido F5 completable en ≤ 6 interacciones para carta simple; contador de mensajes visible en panel de costos.
