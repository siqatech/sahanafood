# UX: Bandeja de conversaciones
> Usuario: agente de atención (puede ser el mismo cajero en negocios chicos). Web/tablet. Fase 5.

## Layout de 3 paneles
Izquierda: lista de conversaciones con filtros (cola, marca, estado, etiqueta, "míos"), badge de canal, preview, tiempo sin respuesta, indicador IA/humano. Centro: hilo con burbujas diferenciadas (cliente / IA con ícono / agente / notas internas en amarillo / sistema), indicador de ventana 24 h con cuenta regresiva, compositor con: texto, atajos "/", plantillas, adjuntar producto (busca en catálogo vivo, envía foto+precio), enviar ubicación, link de pago, respuesta sugerida por IA (botón, editable). Derecha: panel del cliente — perfil CRM, consentimientos, últimos pedidos con reordenar, carrito en curso del bot, acciones (crear pedido, ver timeline, etiquetar).

## Momentos clave
- Tomar conversación derivada: banner con el RESUMEN del bot (intención, datos capturados, carrito) — el agente responde en < 10 s sin releer todo.
- Ventana expirada: compositor cambia a selector de plantillas con explicación de costo.
- Cerrar: resolver con etiqueta de resultado (pedido creado / info / reclamo derivado / spam) — alimenta analítica del agente IA.

## Anti-requisitos
Sin bandeja global cross-tenant (obvio) · sin obligar respuesta desde el celular personal del dueño: la bandeja es la herramienta, WhatsApp Business app queda desconectada del número (Cloud API manda).
