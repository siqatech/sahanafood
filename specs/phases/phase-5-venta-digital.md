# Fase 5 — Venta digital
Objetivo: el canal propio vende y el cliente final tiene experiencia completa.
Alcance: Storefront con dominio propio · Payments online (2 pasarelas mínimo vía adaptador) · links de pago · Bandeja omnicanal (spec 18) · Agente IA configurable con acciones deterministas, fuentes, herramientas de datos vivos, sandbox y presupuesto (spec 19, ADR-0011) · Delivery repartidores + tracking público · capacidad/saturación de cocina (RN-KIT-04) · plataforma ai (docs/28: adaptador, pgvector, prompts versionados, suite dorada en CI) · pentest externo.
Salida: compra real end-to-end con pasarela sandbox → boleta → tracking · demo IA: acción determinista + consulta con datos vivos + carrito + derivación con contexto · suite de conversaciones doradas en verde · validador anti-precio-inventado probado adversarialmente · KPI mensajes/pedido ≤ 8 y costo IA/conversación medido · Lighthouse móvil ≥ 85 · pentest sin hallazgos altos abiertos · canary operativo.
Gate de negocio: 3 operadores piloto usando F4 en producción real ANTES de cerrar F5 (feedback incorporado o registrado).

---

## Backlog ordenado (T5.00 — generado desde las specs, pendiente de aprobación)

Derivado de: **spec 11 (Storefront)**, 10 (Payments — la mitad de F5), 09
(Delivery — repartidores), **spec 18 (Conversations)**, **spec 19 (AI Agent)**,
07 (Kitchen — RN-KIT-04, deuda DT-03 que viene de F4), 14 (CRM, lo mínimo que
la bandeja necesita), `docs/28-ai-platform.md` y ADR-0011.

El orden sale de la dependencia real, no del número de módulo. Tres cadenas
que no se pueden adelantar:

1. **Pagos antes que tienda.** Un storefront sin pasarela es una demo. Y dentro
   de pagos, el **webhook manda sobre el redirect** (RN-PAY-01): construir el
   redirect primero invita a confirmar pedidos con él «mientras tanto», y eso
   ya no se quita.
2. **Bandeja antes que agente IA.** El agente escribe EN una conversación. Sin
   bandeja, el agente necesitaría su propio almacén de mensajes y luego habría
   que fusionarlos — con el histórico ya escrito.
3. **Plataforma `ai` antes que agente.** El adaptador, el registro de uso y el
   presupuesto son la infraestructura que hace que el agente se pueda apagar
   sin que se caiga nada (docs/28: «la IA es una capa, no un cimiento»).

Y una cuarta regla que no es de dependencia sino de riesgo: **el validador
anti-precio-inventado (T5.23) se construye ANTES que la composición libre de
respuestas (T5.24)**. Al revés, se acaba probando el validador contra los
mismos casos que ya pasaban.

| ID | Tarea | Entregable verificable |
|---|---|---|
| **T5.00** | Generar este backlog desde specs y aprobarlo | Este documento aprobado |
| T5.01 | Adaptador de pasarela: puerto `PaymentProvider` + 2 implementaciones sandbox | Cambiar de pasarela = cambiar un `useClass`; ninguna toca el dominio |
| T5.02 | Intenciones de pago (`pay_intents`) + estados | Intención expirada no confirma; aislamiento por tenant |
| **T5.03** | **Webhook de confirmación firmado (RN-PAY-01)** | **El pedido se confirma SOLO por webhook verificado, nunca por redirect**; webhook duplicado → 1 solo confirmado |
| T5.04 | Pago confirmado tras el timeout del pedido | **Reembolso automático + alerta**; el cliente no paga por algo que se rechazó |
| T5.05 | Links de pago (generables desde bandeja y panel) | Link de un solo uso, caduca, no expone el id interno del pedido |
| T5.06 | Reembolsos con doble aprobación sobre umbral (RN-PAY-03) | Reembolso > umbral sin segunda aprobación → 403 + auditoría |
| T5.07 | Conciliación de pasarela y comisiones liquidadas (RN-BIL-04) | Estimada vs liquidada; diferencia reportada, no silenciada |
| T5.08 | Storefront: esqueleto Next.js multi-tenant por dominio/slug | **Aislamiento por dominio: la marca A no sirve el catálogo de B** |
| T5.09 | Resolución de local por zona de la dirección (RN-STO-01) | Sin cobertura → recojo o lista de espera, nunca error genérico |
| T5.10 | Carrito con validación al agregar Y al confirmar (RN-STO-02) | **Agotado entre carrito y checkout → aviso claro**; carrito recuperable |
| T5.11 | Checkout invitado con consentimiento separado (RN-STO-04, RN-T10) | Consentimiento de marketing en su propia casilla, con el texto guardado |
| T5.12 | Cupones v1 | Descuento calculado en `@sahana/domain`, nunca en el front |
| T5.13 | Dominio propio por marca: CNAME + certificado (RN-STO-03) | Fallback a subdominio sahana si el CNAME no resuelve |
| T5.14 | Presupuesto de rendimiento móvil | **Lighthouse móvil ≥ 85** en catálogo y checkout; **JS < 200 KB** en catálogo |
| T5.15 | Delivery: repartidores, asignación manual y estados (spec 09) | Asignación con 3 repartidores y cargas distintas (RN-DLV-01) |
| T5.16 | Tracking público por token + WS | **Sin autenticación y sin datos personales** más que el nombre de pila |
| T5.17 | Cobro contra entrega y liquidación (RN-DLV-02) | La liquidación cuadra con la sesión de caja del turno |
| T5.18 | Capacidad y saturación de cocina (RN-KIT-04) — paga **DT-03** | El canal deja de aceptar cuando la cocina satura, con aviso, no con silencio |
| T5.19 | Bandeja omnicanal: entidades y bandeja por marca/cola (spec 18) | **Dos marcas, mismo teléfono → dos conversaciones que no se cruzan** (RN-CNV-01) |
| T5.20 | Ventana de 24 h visible con cuenta regresiva (RN-CNV-03) | Expirada, **la UI no deja escribir libre y fallar**: ofrece plantillas |
| T5.21 | Acciones del agente humano desde la bandeja (RN-CNV-05) | Crear pedido pasa por `OrderingService` con snapshot correcto, no por SQL |
| T5.22 | Plataforma `ai`: adaptador, colas propias, registro de uso y presupuesto | **Apagar la IA deja el sistema 100 % funcional** (docs/28) |
| T5.23 | RAG con pgvector y **filtro obligatorio por `tenant_id`** | **Prueba de aislamiento específica**: las fuentes de un tenant no aparecen jamás en otro |
| T5.24 | **Validador de salida (RN-AIA-01)** | **Precio, stock, zona u horario sin llamada a herramienta = respuesta bloqueada**; probado adversarialmente |
| T5.25 | Acciones deterministas configurables (spec 19 §2.3) | **Ganan SIEMPRE al LLM**, con costo cero; ordenables y activables por horario |
| T5.26 | Herramientas tipadas del agente (spec 19 §3) | Solo lectura salvo `crm.capture`; el LLM nunca escribe precios ni stock |
| T5.27 | Composición de respuesta con pautas, personalidad y fuentes | Pasa por el validador de T5.24 antes de salir |
| T5.28 | Derivación a humano con contexto (RN-CNV-02, RN-AIA-02/03) | El traspaso lleva **snapshot verificado**: intención, carrito, datos capturados |
| T5.29 | Sandbox de configuración + publicación versionada (spec 19 §2.8) | Publicar = versión inmutable; **rollback en un clic**; la traza explica por qué respondió |
| T5.30 | Presupuesto de IA: alerta al 80 %, degradación al 100 % | **Presupuesto agotado → solo acciones deterministas**, no errores |
| T5.31 | Prompts versionados en `packages/ai-prompts` + **suite de conversaciones doradas en CI** | 20+ diálogos por rubro; **un cambio de prompt que degrada la suite no se mergea** |
| T5.32 | Analítica del agente (spec 19 §6) | Costo por conversación y por pedido; **KPI mensajes/pedido ≤ 8** medido |
| T5.33 | E2E de compra digital | **Intent → webhook → aceptado → boleta (OSE sandbox) → tracking**, en menos de 2 min |
| T5.34 | E2E de la demo de IA | Acción determinista + consulta con datos vivos + carrito + derivación con contexto, en una pantalla |
| T5.35 | Canary y despliegue progresivo (docs/17) | Un despliegue malo se revierte sin tocar la base de datos |
| T5.36 | **Pentest externo** | **Sin hallazgos altos abiertos** (gate de fase) |
| T5.37 | Gate F5 | Checklist `_gates-comunes` + criterios de salida de esta fase |

### Notas de planificación

- **T5.03 y T5.24 son el corazón de esta fase**, por el mismo motivo que T4.04 y
  T4.07 lo eran de la anterior: un fallo ahí no es un bug. En T5.03 es un pedido
  cobrado y no entregado —o entregado y no cobrado—; en T5.24 es un precio
  inventado que el cliente leyó, y ahí ya no importa que el sistema tuviera
  razón. Ambos llevan prueba adversarial, no solo de camino feliz.

- **El pentest (T5.36) es entregable humano.** Se puede preparar el alcance y
  cerrar los hallazgos, pero contratarlo y ejecutarlo no es trabajo de código.
  Igual que T3.16 y T4.31. Conviene lanzarlo cuando T5.08–T5.14 estén en pie:
  antes no hay superficie pública que atacar.

- **El gate de negocio manda sobre el técnico.** La fase exige **3 operadores
  piloto usando F4 en producción real antes de cerrar F5**. Eso no depende de
  este backlog y probablemente sea lo que marque el calendario: requiere que
  DT-02 (entorno cloud) esté resuelto mucho antes del final.

- **Lo que NO entra, aunque esté cerca:** agrupación de pedidos y liquidación de
  repartidores (F6), correo en la bandeja (v2 de la spec 18), mejora continua
  del agente (F8), pronóstico de demanda (F8, y no es LLM). El importador de
  carta por foto de `docs/28` entra solo si T5.08–T5.14 terminan antes de lo
  previsto: es lo primero que se cae del alcance sin dañar la salida de la fase.

- **Deuda permitida en F5:** UI de configuración del agente en su versión mínima
  (funcional, no pulida) y la analítica de conversaciones sin desglose por
  herramienta. Todo lo que toque dinero, tenancy o auditoría, no.
