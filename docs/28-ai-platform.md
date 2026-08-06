# Plataforma de IA transversal

Referencia: ADR-0011. Este documento fija dónde vive la IA en el sistema y sus reglas comunes.

## Superficies
| Superficie | Módulo | Fase | Modelo/técnica |
|---|---|---|---|
| Agente conversacional | 19-ai-agent | 5 | LLM chat + function calling + RAG |
| Respuestas sugeridas al agente humano | 18-conversations | 5 | LLM chat con contexto de conversación |
| "Mejorar con IA": descripciones de producto | Catalog (panel) | 5 | LLM texto corto con reglas de marca |
| "Mejorar con IA": fotos (recorte, fondo, luz) | Catalog (panel) | 5+ | Visión/edición — evaluar costo/beneficio real |
| Importador de carta por foto/PDF | Onboarding (docs/26) | 5 | Visión + extracción estructurada, revisión humana obligatoria |
| Pronóstico de demanda y anomalías | 16-analytics | 8 | Servicio Python (ADR-0006), no LLM |

## Arquitectura
- Módulo de plataforma `ai` en el monolito: adaptador AiProvider (chat/embeddings/visión), colas propias (`ai` con prioridad baja frente a `critical`), caché de embeddings, registro de uso por tenant (tokens, costo, superficie) y presupuesto (ADR-0011).
- RAG: fuentes del tenant → chunking simple → embeddings → pgvector en PostgreSQL (sin infra nueva) con filtro OBLIGATORIO por tenant_id en toda búsqueda (test de aislamiento específico).
- Trazas: cada llamada IA registra prompt-version, herramientas usadas, tokens y costo con trace_id — depurable como cualquier request.
- Prompts versionados en el repo (`packages/ai-prompts`), con suite de conversaciones doradas en CI (spec 19 §7): un cambio de prompt que degrada la suite no se mergea.
- Privacidad: datos de clientes no salen hacia entrenamiento de terceros (configurar proveedor con no-training); PII minimizada en prompts (solo lo necesario para la tarea).

## Lo que la IA NO hace (fijo)
Confirmar pagos · emitir comprobantes · modificar precios o stock · responder fuera del ámbito del negocio · operar sin registro. El "modo IA apagada" siempre deja un sistema 100% funcional: la IA es una capa, no un cimiento.
