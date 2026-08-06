# ADR-0011 — Plataforma de IA: determinista primero, generativa después

Estado: Propuesto · Fecha: 2026-08-06

## Contexto
El diferencial competitivo declarado es "sistema integral conectado con IA" (benchmark: Kommo AI Agents, Agiliza360, QuickEat chatbot). El riesgo de los bots LLM en venta gastronómica es conocido: inventan precios, prometen stock inexistente y queman dinero en mensajes. Los productos que funcionan (Kommo es el ejemplo claro) combinan REGLAS deterministas configurables por el dueño con generación solo donde aporta.

## Decisión
1. **Jerarquía de respuesta obligatoria del agente:** (1º) Acciones deterministas configuradas por el tenant ("cuando pregunta por X → responde exactamente Y") → (2º) Datos vivos del sistema vía herramientas tipadas (catálogo, precios, disponibilidad, zonas, horarios, estado del pedido: el LLM NUNCA los redacta de memoria, los consulta) → (3º) Fuentes de conocimiento del tenant (RAG sobre textos que él carga) → (4º) Generación libre SOLO dentro de pautas, con derivación a humano ante incertidumbre.
2. **El LLM jamás confirma un pedido, un precio o un pago por texto libre:** el carrito y el checkout son estructurados (mensajes interactivos + link a la tienda); la IA guía, no transacciona.
3. **Proveedor vía adaptador `AiProvider`** (chat, embeddings, visión), configurable por entorno; sin dependencia dura de un vendor. Modelos económicos por defecto; escalado por tarea.
4. **Control de costo por tenant:** presupuesto de créditos IA por plan (como Kommo), medición por conversación, corte suave (avisar) y duro (solo reglas deterministas siguen operando: el negocio NUNCA se queda sin responder).
5. **Superficies de IA** (todas opcionales por tenant, on/off): agente conversacional (WhatsApp/web chat) · respuestas sugeridas en la bandeja para agentes humanos · "Mejorar con IA" en descripciones y fotos de producto · importador de carta por foto (docs/26) · pronóstico y anomalías (F8, ADR-0006).
6. **Guardrails fijos no configurables:** no asesoría fuera del negocio, no datos de otros clientes, no inventar promociones, escalar a humano ante queja/reclamo/solicitud legal, y registro completo de conversaciones (auditoría + mejora).

## Consecuencias
+ El diferencial es real y vendible; el costo es acotado; el fallo del LLM degrada a reglas, no a silencio. − Un motor de reglas + RAG + herramientas es trabajo de plataforma (F5) y exige evaluación continua (suite de conversaciones de prueba por rubro, en CI de prompts).
Revisar si: costo por conversación supera el margen del plan; aparece proveedor local de LLM con ventaja de latencia/costo.
