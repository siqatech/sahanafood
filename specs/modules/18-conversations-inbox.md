# Módulo: Conversations (Bandeja omnicanal)
> Fase: 5 · ADRs: 0011, 0012 · Depende de: Identity, CRM, Ordering, WhatsApp

## 1. Alcance
Bandeja unificada de conversaciones por tenant/marca: WhatsApp, chat web de la tienda (y correo v2). Asignación a agentes, colas por marca/local, etiquetas, notas internas, plantillas rápidas, indicador de ventana de 24 h, panel del cliente (perfil CRM + pedidos + carrito en curso), acciones de pedido embebidas, colaboración IA↔humano. NO: help desk genérico con SLAs complejos ni base de conocimiento pública.

## 2. Reglas de negocio
- RN-CNV-01 Una conversación pertenece a (tenant, marca, canal, contacto); el mismo teléfono en dos marcas = dos conversaciones (branding y trazabilidad separados).
- RN-CNV-02 Estados: bot → esperando_humano → asignada → resuelta → (reabre con nuevo mensaje). El traspaso bot→humano lleva SIEMPRE el resumen de contexto (intención detectada, carrito, datos capturados) — nunca "hola, ¿en qué puedo ayudar?" de nuevo.
- RN-CNV-03 Ventana WhatsApp visible con cuenta regresiva; expirada, la UI solo permite plantillas aprobadas y lo indica (no deja escribir libre y fallar).
- RN-CNV-04 Todo mensaje saliente registra autor (bot|agente:id|sistema) y costo estimado si es de pago; contador de mensajes/conversación visible (KPI RN-WA-01).
- RN-CNV-05 El agente humano puede: insertar respuesta sugerida por IA (editable, nunca autoenvío en modo humano), enviar producto con foto+precio desde el catálogo vivo, generar link de pago, crear pedido en nombre del cliente (entra por OrderingService como channel=whatsapp con actor=agente), enviar tracking.
- RN-CNV-06 Reasignación y colas por horario: fuera de horario de atención humana, respuesta automática configurable + la conversación queda en cola con prioridad.
- RN-CNV-07 Notas internas invisibles para el cliente; menciones @agente notifican.
- RN-CNV-08 Búsqueda por teléfono, nombre, texto y nº de pedido (índice propio, sin motor dedicado hasta necesidad medida).

## 3. Entidades
`cnv_conversations(id, tenant_id, brand_id, channel, contact_id, status, assignee_id?, queue, last_msg_at, window_expires_at?, ai_enabled bool)` · `cnv_messages(id, tenant_id, conversation_id, direction, author_type, author_id?, kind[text|interactive|template|media|note|system], payload jsonb, wa_message_id?, status[sent|delivered|read|failed], cost_estimate?)` · `cnv_tags`, `cnv_conversation_tags` · `cnv_quick_replies(tenant_id, brand_id?, shortcut, body)`.

## 4. API / RT
WS: suscripción de bandeja por (marca, cola) + typing + presencia básica. REST: GET /conversations?status&queue&assignee&search · POST /conversations/:id/assign · /resolve · /messages (texto, plantilla, producto, link de pago) · /notes · /tags. Interfaz interna consumida por el módulo 19 (agente IA) y por Integrations (webhooks WhatsApp entrantes crean/actualizan conversación vía inbox idempotente).

## 5. Pruebas
Ventana expirada bloquea texto libre y ofrece plantillas · traspaso bot→humano conserva contexto (snapshot verificado) · dos marcas mismo teléfono no se cruzan · crear pedido desde la bandeja pasa por Ordering con snapshot correcto · aislamiento.

## 6. Criterios de aceptación
Un agente atiende 2 marcas desde una sola bandeja sin confundir branding; tiempo de primera respuesta y mensajes/conversación medidos en Analytics; demo: cliente pregunta → bot responde → pide humano → agente ve carrito y cierra el pedido con link de pago, todo en una pantalla.
