# Deuda técnica

Registro vivo. Toda deuda aceptada entra aquí con fecha límite de pago. Deuda permitida por fase: ver specs/phases.

Reglas: la deuda que toca **dinero, tenancy o auditoría NO es aceptable nunca**. Deuda de UX/reportes/optimización sí, con límite.

Lo que NO es deuda y por eso no está aquí: lo que una fase posterior tiene asignado por planificación (compras y proveedores en F6, pagos online en F5, conectores reales de marketplace en F7). Eso es alcance pendiente, no un atajo que haya que pagar. Aquí solo entra lo que se hizo de una forma sabiendo que la buena es otra.

| ID | Descripción | Fase en que se aceptó | Interés (qué empeora) | Fecha límite | Estado |
|---|---|---|---|---|---|
| DT-02 | **Terraform de entorno dev no entregado** (T3.16). El despliegue no está descrito como código. | F3 | Mientras no exista, no hay entorno de destino: la medición de carga que vale para el SLO (DT-05) y la demo grabada dependen de esto. Además cada día que pasa, el entorno que se acabe montando a mano es más difícil de reproducir. | Antes de abrir F5 | **Bloqueada — necesita credenciales cloud (propietario)** |
| DT-03 | **Capacidad dinámica de cocina sin implementar.** El KDS no limita cuántos pedidos acepta según la carga real de las estaciones. | F4 (deuda permitida explícitamente por la fase) | En hora punta la cocina acepta más de lo que puede producir y los tiempos prometidos al cliente dejan de cumplirse. Empeora con el volumen, no con el tiempo. | F5 | Abierta |
| DT-04 | **La bandeja de excepciones (`needs_review`) tiene API pero no UI.** Resolver un pedido apartado exige llamar al endpoint. | F4 (deuda permitida explícitamente por la fase) | Un pedido apartado que nadie ve es un pedido perdido en la práctica, aunque el dato esté a salvo. El interés lo paga el operador, no el sistema. | F5 | Abierta |
| DT-05 | **Los números de la prueba de carga salen de un contenedor compartido** (Postgres, Redis, API, worker y k6 en cuatro núcleos). Son un suelo, no un SLO. | F4 | Sirven para detectar regresiones, pero no permiten prometer latencia a un cliente. Si se firma un SLO antes de medir sobre la infraestructura real, se firma a ciegas. | Gate de F5, tras DT-02 | Abierta |
| DT-07 | **El costo de inventario es un snapshot del `unit_cost` vigente, no promedio móvil.** Lo exige RN-INV-04 para no falsear el margen histórico, pero el promedio móvil real llega con compras. | F4 | El food cost es correcto para lo ya consumido, pero no refleja variaciones de precio de compra hasta que exista el módulo de compras. | F6 (compras) | Abierta |

## Deuda pagada

| ID | Descripción | Cómo se pagó | Fecha |
|---|---|---|---|
| DT-00 | El worker no arrancaba ningún proceso de fondo: el relay del outbox y el barrido de aceptación existían pero nadie los ejecutaba. | `apps/api/src/workers/main.ts` con `PeriodicJob`, verificado contra BullMQ y Postgres reales y con apagado limpio ante SIGTERM. | F3 |
| DT-01 | **`pnpm audit` corría en CI como informativo (`\|\| true`), no como bloqueante.** Aceptada en F3 con fecha límite en el gate de F5. | Se saldó antes de tiempo, en el gate de F4, porque la auditoría destapó **9 avisos altos**, entre ellos una **inyección SQL en `drizzle-orm`** — y eso toca tenancy, que CLAUDE.md declara deuda inaceptable. Subidos `drizzle-orm` 0.38→0.45.2 y los paquetes de OTel a la línea 2.x; `multer` y dos transitivos de OTel fijados con `pnpm.overrides`. Con cero altos, el paso pasó a bloqueante: un gate que nunca falla no es un gate. | F4 |
| DT-00c | **Un modificador obligatorio sin elegir mandaba el pedido de marketplace a la cola de muertos.** `ModifierError` y `PricingError` viven en `@sahana/domain` y no heredan de `DomainError`, la jerarquía de la API, así que se escapaban por la rama de los fallos transitorios: cinco reintentos contra un payload que no iba a mejorar y `failed` al final. Rompía RN-INT-02 y el criterio de T4.13. | El `catch` de `resolveToOrder` los reconoce y los aparta a `needs_review` al primer intento, con prueba que falla si se revierte. Lo destapó T4.30: 133 envíos en `failed` con el mismo texto. | F4 |
| DT-00b | **Nadie procesaba los webhooks de marketplace en producción.** `IngestionService.processPending` solo se llamaba desde las pruebas: un pedido entraba, recibía su 202 y no llegaba nunca a la cocina. | Barrido `ingestion-sweep` cableado al worker, más `workers/wiring.test.ts`, que falla si un `PeriodicJob` se declara sin arrancarse o sin pararse al apagar. Lo destapó la prueba de carga (T4.30). | F4 |
