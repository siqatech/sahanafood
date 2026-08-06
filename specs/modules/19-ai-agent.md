# Módulo: AI Agent (Agente conversacional configurable)
> Fase: 5 (núcleo) / 8 (mejora continua) · ADRs: 0011 · Depende de: Conversations, Catalog, Ordering, CRM, Organization

## 1. Alcance
Agente de IA por (tenant, marca) 100% configurable por el dueño sin código, al nivel de Kommo/Agiliza360 y por encima: personalidad, pautas, acciones deterministas, fuentes de conocimiento, herramientas de datos vivos, modos de operación, sandbox de prueba, presupuesto y analítica de conversaciones. Multi-agente por marca (cada marca su voz).

## 2. Configuración expuesta al dueño (todo con valores por defecto sensatos)
1. **Identidad:** nombre, rol y personalidad (texto libre), tono (selector: amistoso/formal/juvenil), longitud de respuesta (corta/media), idioma (fijo o "coincidir con el cliente"), demora antes de responder (segundos, para agrupar mensajes partidos — patrón Kommo), emojis sí/no, frases y léxico de marca / palabras prohibidas (patrón Agiliza360).
2. **Pautas:** lista ordenada de instrucciones permanentes (saludo condicionado, qué evitar, cierre con siguiente paso). Plantillas precargadas por rubro.
3. **Acciones deterministas (ganan SIEMPRE al LLM):** condición → respuesta. Condiciones: "pregunta sobre <tema>", "pregunta por primera vez sobre", "el mensaje contiene <texto>", "el cliente quiere <comprar|reservar|reclamar>", "sentimiento es <negativo>", "proporciona su <dato>"; combinables con alguna/todas. Respuestas: mensaje fijo, mensaje fijo + nota de uso, enviar producto(s) del catálogo, enviar ubicación, enviar link (pago/carta/tienda), capturar dato a CRM, etiquetar, derivar a humano, pausar IA en esa conversación. Ordenables por prioridad, activables por horario.
4. **Fuentes de conocimiento:** textos por tema (información del negocio, políticas, eventos, FAQ) con versionado y contador de uso; indexadas para RAG. El catálogo NO es una fuente de texto: es herramienta viva.
5. **Modos por sucursal/horario** (patrón Agiliza360): venta completa · solo reservas · fuera de horario (instrucciones adicionales que se suman a las generales).
6. **Límites y derivación:** temas vedados (fijos de ADR-0011 + propios del tenant), umbral de confianza para derivar, mensaje de derivación, horarios de atención humana.
7. **Presupuesto:** créditos del plan visibles, alerta al 80%, comportamiento al 100% (solo acciones deterministas). 
8. **Sandbox:** chat de prueba contra la config en borrador ANTES de publicar (patrón Kommo "vista previa"), con trazas de por qué respondió (regla disparada / fuente usada / herramienta llamada). Publicar = versión inmutable; rollback a versión anterior en un clic.

## 3. Herramientas tipadas del agente (function calling, solo lectura salvo indicado)
`catalog.search(query, brand, channel)` → productos con precio y foto vigentes · `catalog.availability(product)` · `org.coverage(address|location)` → zona, tarifa, mínimo · `org.hours(brand, location)` · `order.status(phone|order_ref)` · `order.start_cart / cart.add / cart.summary` (estructurado; la confirmación final SIEMPRE es checkout estructurado: mensajes interactivos o link) · `crm.capture(field, value)` (escribe con consentimiento) · `handoff(reason)` · `payment.link(order)`.

## 4. Flujo de decisión por mensaje entrante
normalizar → ¿acción determinista matchea? → responder acción (sin LLM, costo cero) → si no: clasificar intención → ¿requiere dato vivo? llamar herramienta → componer respuesta con pautas+personalidad+fuentes → validador de salida (sin precios no provenientes de herramienta, sin promesas vedadas, longitud) → enviar → registrar traza (regla/fuentes/herramientas/tokens/costo).

## 5. Reglas de negocio
RN-AIA-01 Precio, stock, zona u horario en una respuesta DEBEN provenir de una llamada a herramienta en esa conversación (validador lo verifica; si no, se reformula o deriva). RN-AIA-02 Doble intento fallido de entender = derivar, no insistir. RN-AIA-03 Sentimiento negativo o palabra de reclamo = derivar con prioridad + etiqueta. RN-AIA-04 Config publicada aplica a chats nuevos; los activos terminan con su versión (patrón Agiliza360 "se aplicará al guardar en chats nuevos"). RN-AIA-05 Toda conversación IA es auditable: traza completa reproducible.

## 6. Analítica del agente (panel del dueño)
Conversaciones atendidas solo-IA vs derivadas · tasa de conversión a pedido por origen (IA/humano/mixto) · temas más preguntados sin fuente (sugerencia: "agrega una fuente sobre X") · costo por conversación y por pedido · reglas más disparadas · CSAT opcional post-chat.

## 7. Pruebas
Suite de conversaciones doradas por rubro (20+ diálogos) corrida contra cada cambio de motor o prompt (regresión de calidad) · precio inventado imposible (validador) en test adversarial · presupuesto agotado degrada a reglas · sandbox reproduce la traza · aislamiento de fuentes entre tenants (RAG con filtro tenant_id verificado).

## 8. Criterios de aceptación
El dueño configura desde cero un agente útil en < 30 min con plantilla de rubro; demo end-to-end: cliente pregunta por promociones → acción determinista; pide "algo para 4 personas" → herramienta de catálogo arma sugerencia con precios reales → carrito → checkout estructurado → pedido en KDS; reclamo → humano con contexto.
