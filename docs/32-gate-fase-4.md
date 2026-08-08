# Gate de salida — Fase 4 (Operación principal)

> Evaluación de los criterios de `specs/phases/_gates-comunes.md` y de los de
> salida de `specs/phases/phase-4-operacion.md`.
> Fecha: 8 de agosto de 2026 · Verificado sobre PostgreSQL 16 y Redis reales.
>
> **Veredicto: APTO CON EXCEPCIONES.** El software de la fase está completo y
> verificado. Las dos excepciones son las que el propio backlog anticipó como
> **entregables humanos** —necesitan hardware y una persona—, más la demo
> grabada que viene arrastrada de F3. Ninguna es código pendiente.

---

## 1. Criterios de salida específicos de la Fase 4

La fase declara cuatro. Dos se verifican automáticamente; dos necesitan una
persona delante de una impresora.

| Criterio de salida | Resultado | Evidencia |
|---|---|---|
| **Carga: pico 10× durante 15 min sin pérdida** (outbox = pedidos, DLQ = 0) | ✅ **VERDE** | T4.30. **5 044 pedidos, 0 rechazados, 0 iteraciones perdidas, p95 31,7 ms** (gate < 500 ms). Cero pérdida verificada CONTRA LA BASE por `verify-zero-loss.mjs`, no por los códigos de respuesta |
| **Offline: suite bloqueante de spec 06 en verde** | ✅ **VERDE** | Las tres de la spec: `20 PEDIDOS SIN RED → 20 en servidor con TOTALES IDÉNTICOS`, `CORTE DE RED A MITAD DE LA SINCRONIZACIÓN → sin duplicados`, `NO se cierra la caja con ventas sin sincronizar` |
| **E2E «día de operación»** con 2 cortes de internet | ❌ **NO ENTREGADO** | T4.31 — **entregable humano**, anticipado como tal en el backlog. Ver §5.1 |
| **print-agent instalado desde el instalador en máquina limpia** | ❌ **NO ENTREGADO** | T4.24 — instalador escrito y probado en este contenedor; falta la máquina limpia. Ver §5.2 |

---

## 2. Criterios comunes a toda fase

### 2.1 CI verde completo — ✅ CUMPLE

| Comprobación | Estado |
|---|---|
| ESLint (incluye regla anti-`number` monetario) | ✅ |
| Typecheck (TypeScript estricto, `exactOptionalPropertyTypes`) | ✅ |
| dependency-cruiser (fronteras de módulo) | ✅ **210 módulos, 734 dependencias, 0 violaciones** |
| Prettier | ✅ |
| Pruebas de dominio | ✅ 315 |
| Integración contra Postgres y Redis reales | ✅ 405 |
| print-agent | ✅ 117 |
| **Aislamiento de tenant** | ✅ suite bloqueante sobre **38 endpoints**, más 2 pruebas que verifican el propio detector |
| **SCA (`pnpm audit --audit-level high`)** | ✅ **0 altas — y desde este gate BLOQUEA** (ver §2.3) |

**Total: 837 pruebas en verde.**

### 2.2 Cobertura de dominio — ✅ CUMPLE

`@sahana/domain`: **97,94 % de sentencias, 97,50 % de ramas, 100 % de funciones.**

| Módulo | Ramas | Exigencia |
|---|---|---|
| `money/` (Money + IGV) | **100 %** | 100 % (dinero) ✅ |
| `pricing/` (totales, modificadores, precios, descuentos) | **100 %** | 100 % (dinero) ✅ |
| `ordering/` (máquina de estados) | 100 % | ≥ 90 % ✅ |
| `geo/`, `messaging/`, `state-machine/` | 100 % | ≥ 90 % ✅ |
| `catalog/` | 97,2 % | ≥ 90 % ✅ |
| `offline/` | 97,6 % | ≥ 90 % ✅ |
| `billing/` | 95,8 % | ≥ 90 % ✅ |
| `inventory/` | 92,0 % | ≥ 90 % ✅ |
| `schedule/` | 91,7 % | ≥ 90 % ✅ |

Los dos módulos que llegaban a este gate por debajo del 90 % —`catalog/` con
86,1 % y `offline/` con 89,2 %— se cubrieron aquí en vez de justificarse. Lo que
faltaba no era decorativo: en `offline/`, marcar como sincronizado un pedido que
ya no está en la cola; en `catalog/`, comparar por contenido un campo que es un
objeto. El primero es lo que pasa cuando la respuesta del servidor llega justo
después de purgar; el segundo decide si la PWA se baja el catálogo entero en
cada publicación.

### 2.3 Cero deuda en dinero / tenancy / auditoría — ✅ CUMPLE

- **Dinero:** `Money` entero a escala 4, **100 % de ramas en `money/` y
  `pricing/`**, regla de lint activa. Ninguna ruta calcula importes fuera de
  `@sahana/domain` — tampoco la PWA, que usa el mismo paquete, y hay prueba de
  que los totales coinciden byte a byte tras sincronizar 20 pedidos offline.
- **Tenancy:** RLS habilitada, forzada y con política en toda tabla de negocio,
  verificado por test de esquema que rompe el build. Rol de app sin `BYPASSRLS`.
  Los tres escapes acotados (`app.system`, `app.auth_lookup`,
  `app.integration_lookup`) están documentados en ADR-0014 y **no abren ninguna
  tabla de negocio**.
- **Auditoría:** `audit_log` append-only garantizado por privilegios de BD.

**Una deuda que tocaba tenancy se saldó en este gate.** La auditoría de
dependencias, que corría en modo informativo desde F3, tenía **9 avisos altos
acumulados**. Entre ellos, **inyección SQL en `drizzle-orm` por identificadores
mal escapados** — el ORM que ejecuta todas las consultas con contexto de tenant.
Eso no es deuda aceptable bajo ninguna lectura de CLAUDE.md. Se subió
`drizzle-orm` 0.38 → 0.45.2 y OTel a la línea 2.x, y se fijaron `multer` y dos
transitivos de OTel con `pnpm.overrides`. **Cero altas**, y el paso de CI pasó de
`|| true` a bloqueante: mantenerlo informativo con la casa limpia solo serviría
para que la siguiente entrara igual de callada.

La subida no fue gratis y por eso se verificó a mano: Drizzle 0.45 **envuelve los
errores del driver**, así que la detección de violación de índice único
(`code === '23505'`) dejó de reconocerlos. El síntoma habría sido un cajero
viendo un volcado de SQL en vez de «esta terminal ya tiene una sesión abierta».
Lo cazaron dos pruebas de caja; ahora se recorre la cadena de `cause`, que
funciona con las dos formas.

Deuda restante registrada en `docs/23-technical-debt.md` con fecha límite y
dueño. **Ninguna toca dinero, tenancy ni auditoría.**

### 2.4 Specs actualizadas ante divergencia — ⚠️ PARCIAL

Las divergencias implementadas están registradas. Lo que queda son **cinco
preguntas abiertas** en `docs/22-risks.md`, todas esperando decisión del
propietario, no código:

| ID | Qué falta decidir | Bloquea |
|---|---|---|
| PA-01 | ¿Un mismo email en varios tenants? Hoy se rechaza el acceso en vez de adivinar | Onboarding multi-cliente |
| PA-02 | Qué recursos cuentan contra los límites del plan | Nada de F4 |
| PA-03 | ¿Roles del sistema editables por el tenant? | Nada de F4 |
| PA-04 | Nombre del código `ORDER_BRAND_NOT_SERVED`, que la spec 05 §9 no cataloga | **Sí: un código publicado no se cambia sin romper integraciones** |
| PA-05 | Qué hacer con un pedido fuera de horario (rechazar / apartar / programar) | Canales propios en F5 |

**PA-04 conviene cerrarlo antes de F5**, cuando haya clientes atados al catálogo
de errores.

### 2.5 progress.md actualizado y demo grabable — ⚠️ PARCIAL

- `docs/progress.md`: ✅ actualizado, con estado y evidencia por tarea, y con los
  fallos encontrados escritos tal cual, no maquillados.
- **Demo grabada: ❌ NO ENTREGADA.** Arrastrada de F3. El alcance es reproducible
  por comandos (`make up`, `make migrate`, `make demo-tenant`, `make load`), pero
  grabarla es un entregable humano. **Dueño: propietario del producto.**

### 2.6 Checklist OWASP de la fase — ✅ CUMPLE (sin hallazgos altos)

Aplicado a lo que F4 añadió: catálogo, pedidos, POS y caja, KDS, inventario,
facturación, WhatsApp, analítica y **la superficie nueva más expuesta, el webhook
de marketplace**, que es el único endpoint que atiende a un desconocido.

| OWASP Top 10 | Estado tras F4 |
|---|---|
| A01 Control de acceso roto | Guard global `@RequirePermission` en todo endpoint nuevo; **suite de aislamiento ampliada a 38 endpoints**; RLS como segunda barrera. Dos fallos de este tipo aparecieron durante la fase y se corrigieron: un endpoint que devolvía **200 con ceros** para un pedido ajeno (ahora 404) y varios 404 que **repetían el id preguntado** |
| A02 Fallos criptográficos | Credenciales de conector cifradas con clave derivada por tenant (HKDF); el secreto de firma **nunca sale en las respuestas** (`redactCredentials`) ni entra en auditoría; PIN de supervisor con argon2id. **Sin datos de tarjeta almacenados**: la pasarela llega en F5 y será tokenizada |
| A03 Inyección | Consultas parametrizadas siempre. **La inyección SQL de `drizzle-orm` (GHSA) se cerró en este gate subiendo a 0.45.2** |
| A04 Diseño inseguro | Firma HMAC sobre el cuerpo **crudo** comparada en tiempo constante; correlativo de comprobantes con `FOR UPDATE`, sin huecos bajo concurrencia; descuentos sobre umbral con PIN; cierre de caja con diferencia exige motivo + PIN |
| A05 Configuración insegura | Config validada al arranque; **el proceso no arranca en producción con los secretos por defecto del repositorio**; `raw`/`json` con límite de 1 MB; lote de sincronización acotado (200 pedidos de golpe se rechazan) |
| A06 Componentes vulnerables | ✅ **0 altas, y el paso BLOQUEA desde este gate** |
| A07 Fallos de identificación | Sin cambios respecto a F3: JWT corto + refresh rotativo con detección de reuso, bloqueo de PIN persistido |
| A08 Integridad de datos/software | Outbox transaccional; `audit_log`, `ord_timeline`, `inv_movements` y las versiones de catálogo **inalterables por privilegios de BD**; idempotencia por `(tenant, canal, external_id)` e `Idempotency-Key` |
| A09 Fallos de registro y monitoreo | Auditoría de las acciones que exige `docs/14 §auditoría` (ver abajo); traza que sobrevive request → outbox → worker; **el filtro de Problem Details ya registra los 5xx con su stack** — se añadió en F4 y fue lo que permitió diagnosticar un fallo de ingesta en segundos |
| A10 SSRF | El webhook **entra**, no sale. Las llamadas salientes de F4 (OSE, WhatsApp) van contra simuladores locales con URL de configuración, nunca del payload |

**Auditoría contra `docs/14-security.md §auditoria`:** cubiertas anulación/NC de
comprobantes, descuentos sobre umbral, cancelaciones, modificación de pedido
aceptado, ajustes de inventario, cambios de permisos y apertura/cierre de caja
con diferencia. **No aplican todavía**, por no existir la superficie: cambios de
precio (no hay endpoint de edición de precios; el catálogo se publica versionado
y esa publicación sí se audita), acceso de soporte cross-tenant y exportaciones
masivas. **Al abrir esas superficies en F5 hay que añadir su auditoría en el
mismo commit**, no después.

**Sin hallazgos altos abiertos.** Pendiente por fase: MFA, rate limiting,
cifrado campo a campo con KMS y **pentest externo** (todos gate de F5).

### 2.7 Aprobación del propietario — ⏳ PENDIENTE

Este documento es la solicitud.

---

## 3. Los gates duros de la fase, uno a uno

No son «pruebas que pasan»: son las cinco afirmaciones que esta fase tenía que
poder sostener.

| Afirmación | Cómo se comprueba | Resultado |
|---|---|---|
| **Ningún pedido se pierde jamás** | Webhook aceptado → pedido o `needs_review`, nunca otra cosa. Verificado matando el worker a mitad de la ingesta (T4.15) y con volumen (T4.30) | ✅ |
| **Los totales del POS offline son idénticos a los del servidor** | 20 pedidos sin red, comparación de `Money` a nivel de unidades menores | ✅ |
| **El correlativo de comprobantes no tiene huecos** | Emisión concurrente con `FOR UPDATE`; el número se persiste y no vuelve nunca al pozo | ✅ |
| **Un dedupe concurrente no crea dos pedidos** | Dos workers, mismo `external_ref`, un solo pedido | ✅ |
| **La analítica cuadra con Billing** | `reconcileWithBilling`; la spec 16 declara la divergencia bug crítico | ✅ *(tras corregir un fallo de zona horaria — ver §4)* |

---

## 4. Lo que esta fase encontró al ejecutarse

Vale la pena dejarlo escrito porque todos comparten un patrón: **ninguno lo
detectó una prueba unitaria; los destapó ejecutar el sistema de verdad.**

1. **Nadie procesaba los webhooks de marketplace en producción.**
   `IngestionService.processPending` existía desde el principio, con sus pruebas
   en verde, y solo se llamaba desde los tests. Un pedido habría entrado,
   recibido su 202 y no habría llegado nunca a la cocina. El hueco no estaba en
   el servicio: estaba en el **arranque**, que es lo que casi nunca se prueba.
   Lo destapó la prueba de carga. Hay ahora un test que falla si un trabajo
   periódico se declara sin arrancarse.

2. **La conciliación decía «todo cuadra» en las horas de más venta.** El día de
   negocio se calculaba en UTC mientras la proyección y los comprobantes usan
   `America/Lima`. Entre las 19:00 y medianoche preguntaba por el día siguiente,
   no encontraba nada y respondía `matches: true`. Apareció porque la suite corrió
   de madrugada; a cualquier otra hora habría pasado en verde.

3. **Un modificador obligatorio sin elegir mandaba el pedido a la cola de
   muertos.** `ModifierError` vive en `@sahana/domain` y no hereda de
   `DomainError`, la jerarquía de la API, así que un error del CONTENIDO se
   trataba como transitorio: cinco reintentos y `failed`. Violaba RN-INT-02 y el
   criterio de T4.13 directamente.

4. **La subida de Drizzle rompió la detección de índice único en silencio.** Ver
   §2.3. El compilador no dice nada cuando un error cambia de forma.

5. **El agente de impresión duplicaba comandas** cuando dos vaciados de cola se
   solapaban, y **una línea larga desbordaba el papel**. Lo primero lo encontró
   una prueba con dos `drain()` a la vez; lo segundo, leer la salida impresa.

---

## 5. Lo que NO se entrega, y por qué

### 5.1 T4.31 — E2E «día de operación»

Exige apertura de caja, 30 pedidos mezclando canales, **dos cortes de internet
reales**, cierre cuadrado e impresión en ambos estados. Las piezas están
verificadas por separado y el guion es reproducible, pero la prueba consiste
precisamente en **una persona desenchufando la red con comida en marcha**. El
backlog ya la clasificó como entregable humano.

**Dueño: propietario del producto.** Necesita mini PC, impresora térmica y
tablet.

### 5.2 T4.24 — Instalador en máquina limpia

El instalador está escrito, es idempotente, comprueba la versión de Node y se
probó en este contenedor. Lo que falta es **una máquina limpia de verdad**:
Linux con systemd y Windows con su servicio. Un instalador que solo se ha
ejecutado donde ya estaba todo instalado no ha demostrado lo que promete.

**Dueño: propietario del producto.**

### 5.3 Demo grabada

Arrastrada de F3. **Dueño: propietario del producto.**

---

## 6. Backlog de la Fase 4: estado final

| ID | Tarea | Estado |
|---|---|---|
| T4.00 | Backlog de la fase | ✅ Finalizada |
| T4.01–T4.06 | Catálogo: entidades, modificadores, precios, disponibilidad, publicación versionada | ✅ Finalizadas |
| T4.07–T4.13 | Ordering: máquina de estados, submit, idempotencia, validaciones, transiciones, aceptación, bandeja de excepciones | ✅ Finalizadas |
| T4.14–T4.15 | Simulador de marketplace + caos de ingesta | ✅ Finalizadas |
| T4.16 | KDS por estación | ✅ Finalizada |
| T4.17–T4.19 | Caja: sesiones, arqueo, descuentos con PIN | ✅ Finalizadas |
| T4.20–T4.22 | POS offline: cola local, sincronización, corte a mitad | ✅ Finalizadas |
| T4.23 | print-agent v1 | ✅ Finalizada |
| **T4.24** | **Instalador en máquina limpia** | ⚠️ **Código sí, ejecución humana no** |
| T4.25 | Recetas y consumo de stock | ✅ Finalizada |
| T4.26–T4.27 | Billing: OSE sandbox, correlativo, emisión diferida | ✅ Finalizadas |
| T4.28–T4.29 | WhatsApp + analítica conciliada | ✅ Finalizadas |
| T4.30 | Pruebas de carga con k6 | ✅ Finalizada |
| **T4.31** | **E2E «día de operación»** | ❌ **Entregable humano** |
| T4.32 | Gate F4 | 🔵 Este documento |

---

## 7. Riesgos técnicos: estado tras F4

| Riesgo | Antes de F4 | Ahora |
|---|---|---|
| R-03 Fuga entre tenants | Mitigado y verificado | ✅ **Mitigado — verificación ampliada a 38 endpoints** |
| R-04 Descuadre por float | Mitigado y verificado | ✅ **Mitigado — ahora también en el POS offline** |
| R-05 Divergencia offline/servidor | Por verificar en F4 | ✅ **Mitigado y verificado**: mismo paquete de dominio, totales idénticos |
| R-07 Pérdida de eventos | Mitigado y verificado | ✅ **Mitigado — y el agujero que quedaba (nadie consumía la ingesta) está cerrado** |
| R-12 Equipo sin experiencia TS | Abierto | 🔴 **Abierto — DP-01** |
| Rendimiento bajo pico | Sin medir | 🟡 **Medido en local, sin medir en destino** (DT-05, depende de DT-02) |

---

## 8. Lo que la Fase 5 puede dar por hecho

- **Un pedido entra por cualquier canal y no se pierde**: POS con o sin red,
  webhook firmado, programado. Y si algo va mal, acaba en una bandeja, no en un
  log.
- **El dinero es exacto de punta a punta**, incluido el navegador, y cuadra con
  lo declarado a SUNAT.
- **La cocina se entera por eventos**, con cuatro consumidores independientes que
  no se pisan.
- **Los procesos de fondo arrancan de verdad** — y hay una prueba que lo vigila.
- **La caja cuadra o exige una firma**, y todo lo sensible queda auditado.

---

## 9. Solicitud de aprobación

Se solicita aprobación para **cerrar la Fase 4 y abrir la Fase 5**, aceptando
las tres excepciones documentadas (T4.31, la ejecución del instalador de T4.24 y
la demo grabada), **todas con dueño humano y ninguna bloqueante para el
desarrollo de la Fase 5**.

Se pide además, antes de entrar en F5:

- **Cerrar PA-04** (nombre del código de error), porque un código publicado ya no
  se cambia.
- **Decidir DP-02** (proveedor OSE) y **DP-04** (BSP de WhatsApp), que hoy corren
  contra simuladores.
- **Desbloquear DT-02** (credenciales cloud): sin entorno de destino no hay
  medición de carga que valga para un SLO, ni pentest, ni demo desplegada.
