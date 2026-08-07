# Fase 4 — Operación principal
Objetivo: una dark kitchen multimarca opera su día completo con Sahana.
Alcance: Catalog completo · Ordering (spec canónica) · POS PWA offline + print-agent v1 · Cash · KDS por estación · Inventory (recetas+consumo) · Billing con OSE sandbox · WhatsApp notificaciones · Analytics básico · SIMULADOR de marketplace · pruebas de carga k6.
Salida: E2E "día de operación": apertura de caja → 30 pedidos mezclando POS/simulador/programados → 2 cortes de internet → cierre cuadrado, comprobantes emitidos, stock consistente, timeline completo por pedido · carga: pico 10× 15 min sin pérdida (outbox=pedidos, DLQ=0) · offline: suite bloqueante de 06-pos-cash en verde · print-agent instalado desde instalador en máquina limpia.
Deuda permitida: capacidad dinámica de cocina (pasa a F5), UI de bandeja de excepciones básica.

---

## Backlog ordenado (T4.00 — generado desde las specs, pendiente de aprobación)

Derivado de: spec 04 (Catalog), **spec 05 (Ordering — canónica)**, 06 (POS y Caja),
07 (Kitchen/KDS), 08 (Inventory parcial), 10 (Billing parcial), 12 (WhatsApp
parcial), 13 (Integrations — simulador), 16 (Analytics básico).

Orden elegido por dependencia real, no por número de módulo: **el catálogo debe
existir antes que el pedido** (un pedido necesita precios que resolver), **el
orquestador antes que POS y KDS** (ambos son clientes suyos), y **el simulador
antes que la carga** (es lo que genera el pico de 10×).

| ID | Tarea | Entregable verificable |
|---|---|---|
| **T4.00** | Generar este backlog desde specs y aprobarlo | Este documento aprobado |
| T4.01 | Catálogo: entidades, categorías, productos, variantes | CRUD con aislamiento; migración con RLS |
| T4.02 | Modificadores y combos en `@sahana/domain` (min/max, precio ±) | Validación idéntica en servidor y PWA; 100 % ramas en el cálculo |
| T4.03 | Listas de precios por (marca, canal, local) — RN-CAT-01 | Resolución en los 3 niveles testeada; sin precio → invisible en el canal |
| T4.04 | Cálculo de totales completo en `@sahana/domain` (líneas + modificadores + descuentos + IGV) | Property test: Σlíneas = total; 100 % ramas (gate de dinero) |
| T4.05 | Disponibilidad y pausa de producto (RN-CAT-03) | Pausa propagada < 60 s medido con evento `catalog.availability_changed` |
| T4.06 | Publicación versionada del catálogo + `GET /catalog/resolved` | Versión inmutable descargable; publicación no bloquea ventas |
| **T4.07** | **Máquina de estados de pedido en `@sahana/domain`** | Toda transición válida e inválida testeada; **test de simetría PWA↔servidor** |
| T4.08 | `OrderingService.submit()` + entidades `ord_*` + snapshot inmutable (RN-ORD-02) | Ningún módulo escribe `ord_*` directamente (verificado por dep-cruiser) |
| T4.09 | Idempotencia y dedupe (RN-ORD-03, ADR-0010) | **Dedupe concurrente: 2 workers, mismo `external_ref` → 1 pedido** |
| T4.10 | Validaciones de submit (RN-ORD-09): cobertura, disponibilidad, mínimo, marca en cocina | Cada error con su código de Problem Details |
| T4.11 | Transiciones + API de pedidos (accept/reject/cancel/modify) + timeline | 409 en transición inválida; timeline reconstruible (runbook 1) |
| T4.12 | Aceptación automática/manual con timeout (RN-ORD-04) y programados (RN-ORD-05) | Programado en frontera de horario; auto-rechazo a los 10 min |
| T4.13 | Bandeja de excepciones `needs_review` (RN-ORD-10) | **Ningún pedido se pierde jamás**: webhook ack'd → pedido o needs_review |
| T4.14 | Simulador de marketplace (spec 13) | Genera pedidos, duplicados y fallos de mapeo de forma reproducible |
| T4.15 | Prueba de caos de ingesta | Matar el worker durante la ingesta: cero pérdida |
| T4.16 | KDS: tickets por estación, estados de preparación (spec 07) | `preparing` al primer ticket; `ready` cuando todos listos |
| T4.17 | Sesiones de caja y movimientos (spec 06) | No se vende sin caja abierta (RN-POS-01) |
| T4.18 | Arqueo y cierre con diferencia (RN-POS-02) | Diferencia ≠ 0 exige motivo + PIN supervisor → auditoría |
| T4.19 | Descuentos con PIN sobre umbral (RN-POS-03/RN-T08) | Usa `verifyPinForSensitiveAction` (ya construido en F3) |
| T4.20 | PWA POS: esqueleto offline-first con IndexedDB y cola local | Vende sin red; ULID de cliente como clave natural |
| T4.21 | Sincronización offline (RN-T07, F3 de spec 05) | **20 pedidos sin red → 20 en servidor, totales idénticos** (Money PWA vs servidor) |
| T4.22 | Corte de red a mitad de sincronización | Sin duplicados |
| T4.23 | print-agent v1: ESC/POS, cola propia, reintentos (ADR-0008) | Comanda y precuenta impresas en línea y sin red |
| T4.24 | Instalador del print-agent | Instalado en máquina limpia (gate de fase) |
| T4.25 | Recetas y consumo automático de stock (spec 08 parcial) | Consumo por componentes en combos (RN-CAT-04) |
| T4.26 | Billing: adaptador OSE en sandbox + correlativo transaccional sin huecos | Correlativo sin huecos bajo concurrencia |
| T4.27 | Emisión diferida de comprobantes cuando hay corte | Encolados y emitidos dentro del límite normativo |
| T4.28 | WhatsApp: notificaciones de estado (spec 12 parcial) | Plantillas; KPI de mensajes por pedido |
| T4.29 | Analytics básico: rentabilidad por marca y canal (spec 16 parcial) | Conciliación con pedidos del día |
| T4.30 | Pruebas de carga con k6 | **Pico 10× durante 15 min sin pérdida** (outbox = pedidos, DLQ = 0); p95 submit < 500 ms |
| T4.31 | E2E «día de operación» | Apertura → 30 pedidos mezclando canales → **2 cortes de internet** → cierre cuadrado, comprobantes emitidos, stock consistente |
| T4.32 | Gate F4 | Checklist `_gates-comunes` + criterios de salida de esta fase |

### Notas de planificación

- **T4.04 y T4.07 son el corazón.** El cálculo de totales y la máquina de
  estados viven en `@sahana/domain` y los consumen servidor y PWA. Un error ahí
  produce comprobantes SUNAT incorrectos (problema tributario, no bug). Ambos
  llevan gate de 100 % de ramas.
- **T4.24 (instalador en máquina limpia) y T4.31 (día de operación con cortes
  reales) requieren hardware y una persona.** Se entregarán como procedimiento
  automatizado + guion reproducible; la ejecución sobre hardware real es un
  entregable humano, igual que T3.16.
- **T4.28 (WhatsApp) depende de DP-04** (BSP o Cloud API directa) y de la
  verificación de Meta Business. Si no está resuelta al llegar, se implementa
  contra un simulador local, como se hace con los marketplaces.
- **T4.26 (OSE) depende de DP-02** (proveedor OSE). Sin proveedor elegido se
  implementa el adaptador contra un sandbox simulado y se conecta el real
  después: el anti-corruption layer hace que el cambio no toque el dominio.

