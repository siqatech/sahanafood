# Gate de salida — Fase 5 (Venta digital)

> Evaluación de los criterios de `specs/phases/_gates-comunes.md` y de los de
> salida de `specs/phases/phase-5-venta-digital.md`.
> Fecha: 8 de agosto de 2026 · Verificado sobre PostgreSQL 16 + pgvector y Redis
> reales.
>
> **Veredicto: APTO CON EXCEPCIONES.** El software de la fase está completo y
> verificado. Las excepciones son las que el propio backlog anticipó como
> **entregables humanos**: el pentest externo, el gate de negocio con tres
> operadores piloto y la medición de Lighthouse en un móvil real. Ninguna es
> código pendiente, y las tres dependen de **DT-02: no hay entorno cloud**.
> La deuda **DT-08 —que vencía en este gate— queda saldada** (ADR-0018).
>
> **Revisado el 9 de agosto de 2026** (§8). El veredicto no cambia, pero el
> alcance sí: tras firmar este gate se descubrió que **la fase no tenía
> interfaz de usuario ninguna** —ni panel, ni POS, ni KDS— y que faltaba la
> mitad de escritura del catálogo y la organización. Las tres deudas
> (DT-09, DT-10, DT-11) están saldadas. El repaso de `specs/ux/` encontró
> después **dos pantallas más que no existían** —el centro de operaciones, sin
> el cual no había forma de aceptar un pedido, y la bandeja de conversaciones—:
> DT-04, DT-14 y DT-15 también quedan saldadas. Abiertas: DT-12 y DT-13. Con
> esto, **las seis specs de `specs/ux/` tienen pantalla**, y §8.8 fija el
> criterio de entrada de F6 que habría evitado los tres agujeros.

---

## 1. Criterios de salida específicos de la Fase 5

La fase declara ocho. Cinco se verifican automáticamente; tres necesitan una
persona, un móvil o un tercero.

| Criterio de salida | Resultado | Evidencia |
|---|---|---|
| **Compra real end-to-end con pasarela sandbox → boleta → tracking** | ✅ **VERDE** | T5.33. Camino del comprador **sin un solo atajo interno**: carta desde el dominio de la marca → carrito de servidor → checkout con pago en línea → webhook **firmado** → aceptación por el barrido real → boleta contra el sandbox del OSE (`B001-00000001`) → tracking público sin sesión. **~0,3 s** frente al criterio de 2 minutos |
| **Demo IA: acción determinista + datos vivos + carrito + derivación con contexto** | ✅ **VERDE** | T5.34. Los cuatro pasos **en una sola conversación**, por el camino real (mensaje → outbox → consumidor → agente) y leídos del hilo, que es lo que el dueño ve. El enlace de carrito que manda el bot **se abre y funciona** |
| **Suite de conversaciones doradas en verde** | ✅ **VERDE** | T5.31. **24 diálogos, 3 rubros, 29 turnos** contra el agente real con proveedor determinista. Corre como paso **propio y bloqueante** de CI; se verificó que **falla de verdad** rompiendo una expectativa a propósito |
| **Validador anti-precio-inventado probado adversarialmente** | ✅ **VERDE** | T5.24. La prueba levanta **la aplicación entera** con un proveedor que responde «el pollo cuesta S/ 99.00» y comprueba que ese texto **no llega al cliente**. Compara **importes exactos en céntimos**, no solo el tipo de dato |
| **KPI mensajes/pedido ≤ 8 y costo IA/conversación medido** | ✅ **VERDE** | T5.32. Medido, no declarado: el vínculo conversación→pedido es una **fila** (`cnv_conversation_orders`) y los tokens se guardan en la traza. Sin pedidos el KPI queda en `null` —ni cumple ni incumple—, porque un `≤` sobre cero pintaría el panel en verde el día que el agente no vendió nada |
| **Canary operativo** | ⚠️ **PARCIAL** | T5.35. Lo que hace posible revertir está hecho y **bloquea en CI**: gate de compatibilidad de migraciones + sonda `/health/ready` que da por listo un esquema **por delante** del código. El balanceador y el reparto de tráfico son infraestructura cloud → **DT-02**. Ver §5.3 |
| **Lighthouse móvil ≥ 85** | ❌ **NO ENTREGADO** | T5.14. El presupuesto de JS sí bloquea el build (**106 KB de 200**, medido **comprimido**); la puntuación de Lighthouse depende de la máquina y en CI da falsos rojos o umbrales que no significan nada. Ver §5.4 |
| **Pentest sin hallazgos altos abiertos** | ❌ **NO ENTREGADO** | T5.36 — **entregable humano**, anticipado como tal en el backlog. Ver §5.1 |

---

## 2. Criterios comunes a toda fase

### 2.1 CI verde completo — ✅ CUMPLE

| Comprobación | Estado |
|---|---|
| ESLint (incluye regla anti-`number` monetario) | ✅ |
| Typecheck (TypeScript estricto, `exactOptionalPropertyTypes`) | ✅ |
| dependency-cruiser (fronteras de módulo) | ✅ **310 módulos, 1 126 dependencias, 0 violaciones** — ni una advertencia, por primera vez |
| Prettier | ✅ — y **el gate volvió a verde** tras varios commits en rojo (§4.1) |
| **Compatibilidad de migraciones** (nuevo, T5.35) | ✅ **30 migraciones, todas admiten volver a la imagen anterior** |
| Pruebas de dominio | ✅ **438** |
| Integración contra Postgres + pgvector y Redis reales | ✅ **573** (40 archivos) |
| `@sahana/print-agent` | ✅ **117** |
| `@sahana/ai-prompts` | ✅ **7** |
| **Aislamiento de tenant** | ✅ suite bloqueante sobre **66 casos**, incluida la superficie pública de la tienda |
| **Suite dorada del agente** | ✅ paso propio y bloqueante |
| **Navegador (tienda)** | ✅ **6 pruebas, 3,4 s**, job propio y bloqueante (ADR-0018) |
| **SCA (`pnpm audit --audit-level high`)** | ✅ **0 altas** — ver §2.3 |

**Total: 1 141 pruebas en verde.**

### 2.2 Cobertura de dominio — ✅ CUMPLE

`@sahana/domain`: **97,81 % de sentencias, 96,15 % de ramas, 99,5 % de
funciones.**

| Módulo | Ramas | Exigencia |
|---|---|---|
| `money/` (Money + IGV) | **100 %** | 100 % (dinero) ✅ |
| `pricing/` (totales, modificadores, precios, descuentos) | **100 %** | 100 % (dinero) ✅ |
| `ordering/`, `geo/`, `messaging/`, `conversations/`, `state-machine/` | 100 % | ≥ 90 % ✅ |
| `catalog/` | 97,2 % | ≥ 90 % ✅ |
| `offline/` | 97,6 % | ≥ 90 % ✅ |
| `billing/` | 95,8 % | ≥ 90 % ✅ |
| `kitchen/` | 95,0 % | ≥ 90 % ✅ |
| `payments/` | 94,1 % | ≥ 90 % ✅ |
| `delivery/` | 93,5 % | ≥ 90 % ✅ |
| `ai/` | 92,4 % | ≥ 90 % ✅ |
| `inventory/` | 92,0 % | ≥ 90 % ✅ |
| `schedule/` | 91,7 % | ≥ 90 % ✅ |
| `storefront/` | 86,7 % | ≥ 90 % ⚠️ |

**Una excepción declarada:** `storefront/coupon.ts` queda en 86,7 % de ramas. Lo
que falta son las combinaciones de rechazo de cupón que ya están cubiertas por
las pruebas de integración de la tienda —el cupón bajo mínimo, el caducado, el
agotado— contadas allí y no aquí. **No es dinero**: el importe del descuento sí
está al 100 %, y es la rama que decide cuánto se cobra. Se anota como pendiente
menor, no como bloqueo.

### 2.3 SCA — ✅ CUMPLE, y esta fase lo devolvió a verde

El gate bloquea en alto desde F4. Al preparar este documento estaba **en rojo con
3 hallazgos altos**, todos transitivos de Next.js:

- **`sharp` < 0.35.0** — cuatro CVE heredados de `libvips`.
- **`postcss` ≤ 8.5.11 y ≤ 8.5.17** — lectura arbitraria de ficheros y *path
  traversal* vía `sourceMappingURL` en comentarios CSS.

Saldados con `overrides` (`sharp >= 0.35.0`, `postcss >= 8.5.18`), verificando
después que la tienda **sigue compilando y dentro de presupuesto**. Quedan 4
moderadas y 1 baja, que el gate no bloquea; la línea se sube cuando el pentest
diga dónde ponerla, no antes.

### 2.4 Aislamiento multi-tenant — ✅ CUMPLE

Los **66 casos** de la suite incluyen la superficie que más lo necesitaba: la
tienda, que es **la única que atiende sin sesión**. El harness tuvo que
cambiarse para cubrirla (§4.2).

---

## 3. Lo que esta fase entregó, en una línea cada cosa

| Bloque | Qué quedó en pie |
|---|---|
| **Pagos** (T5.01–T5.07) | Adaptador con dos sandbox deliberadamente distintos · el pedido se confirma **solo por webhook verificado** y no existe endpoint de confirmación (hay prueba de que no existe) · devolución automática del pago que llega tarde · reembolsos con **dos personas distintas** · comisiones liquidadas, que hasta T5.07 el panel enseñaba a cero |
| **Tienda** (T5.08–T5.14) | Tenant resuelto por `Host` y **jamás por un parámetro** · carrito de servidor · checkout invitado con consentimiento acreditable (Ley 29733) · cupones sobre el subtotal · **presupuesto de JS que bloquea el build** |
| **Delivery** (T5.15–T5.17) | El envío es entidad aparte con su máquina de estados · no se entrega sin haber recogido · zona como **filtro** · el COD es dinero del repartidor hasta que liquide · tracking público reutilizando `pub_tokens`, **sin escape de RLS nuevo** |
| **Cocina** (T5.18) | Dos umbrales: el primero **extiende la promesa y sigue vendiendo**; el segundo pausa canales, menor margen primero. Paga DT-03 |
| **Bandeja** (T5.19–T5.21) | Conversación por (tenant, marca, canal, contacto) · ventana de 24 h que **no deja escribir y fallar** · traspaso con resumen **obligatorio en la base** |
| **Agente IA** (T5.22–T5.32) | Jerarquía de ADR-0011 completa · validador de salida probado adversarialmente · configuración versionada con rollback · presupuesto que **degrada a reglas, no a error** · prompts versionados con suite dorada bloqueante · analítica con el KPI medido · **y el consumidor que hace que el agente conteste a alguien** (§4.3) |
| **Despliegue** (T5.35) | Gate de compatibilidad de migraciones + sonda de readiness que hace posible revertir **sin tocar la base** |

---

## 4. Lo que se rompió por el camino, y qué lo destapó

Esta sección existe porque es la más útil dentro de seis meses.

### 4.1 Cuatro fallos que ninguna prueba veía, todos de la misma familia

El patrón se repitió toda la fase: **una pieza bien hecha que nadie conecta.**

| Qué | Cómo se veía | Qué lo destapó |
|---|---|---|
| `commission_estimated` con `DEFAULT 0` y **ningún escritor** | El panel restaba una comisión de cero y **enseñaba el margen bruto llamándolo margen** | T5.07 |
| `buildSystemPrompt` y `SYSTEM_PROMPT_VERSION` escritos y **sin usar** | El agente construía su prompt con una función local; ningún cambio de prompt dejaba rastro | T5.31 |
| `input_tokens` / `output_tokens` en la tabla desde `0028`, **nunca escritos** | El coste por conversación solo se podía estimar | T5.32 |
| **`conversation.message_received` sin consumidor** | Toda la plataforma del agente —reglas, herramientas, RAG, validador, presupuesto, suite dorada— construida, probada y **sin contestar a ningún cliente**: la única ruta que llamaba al agente era el sandbox del dueño | T5.32 |

El último es de otra escala: no faltaba una llamada dentro de un flujo, **faltaba
el flujo entero**. Ninguna prueba lo detectó porque todas llamaban a `respond` a
mano — incluida la primera versión de la suite dorada, que medía un camino que
ningún cliente recorre.

**Contramedida, ya en CI:** la prueba de cableado de T4.30 solo vigilaba los
`PeriodicJob`. Ahora recorre las APIs públicas de los módulos y **exige que todo
`*_CONSUMER` exportado esté registrado en el worker**. Se verificó desconectando
el de IA a propósito.

**Lo mismo pasaba con el cobro.** El checkout de la tienda creaba el pedido y lo
dejaba **sin forma de pagarlo**: crear una intención exige `payments.charge`, un
permiso de personal que un comprador invitado no tiene ni debe tener. Lo destapó
el extremo a extremo de T5.33, no una revisión de código.

### 4.2 Tres fallos que solo se ven ejecutando

Al montar `apps/web` aparecieron tres que pasaron typecheck, lint y las 484
pruebas de entonces: `fetch` de Node **descarta en silencio la cabecera `host`**
(la tienda pedía el catálogo sin decir de quién era), los precios se pintaban
**`S/ NaN`**, y un archivo `'use server'` **no puede exportar una constante**.
Comparten la forma: **la página carga bien**. Ninguna prueba mira una página →
**DT-08** — **saldada** con ADR-0018 (ver §4.2).

El harness de aislamiento tampoco servía para la tienda: comparaba la respuesta
con el token de A y con el de B, y en la tienda **el token ni se mira**. Se
añadió `requestAsB` y se **exige declararla**, en vez de saltarse la
comprobación en la única superficie que atiende sin sesión.

### 4.3 La tilde, tres veces

`\b` de JavaScript no casa detrás de una vocal acentuada. Rompió, en tres sitios
distintos: la detección de reclamos (`no llegó` nunca disparaba), el enrutado de
herramientas (`¿me pasas el menú?` y `¿hacen envío?` no consultaban nada) y, de
paso, la concordancia de género (`la pizza llegó fría` pasaba como conversación
normal). Los límites de palabra son ahora *lookarounds* sobre `\p{L}\p{N}`.

### 4.4 El validador bloqueó una respuesta legítima, y tenía razón

La herramienta de carrito decía «Carrito **abierto** para este cliente». El
validador leyó «abierto» como afirmación de horario, no encontró herramienta que
la respaldara y bloqueó la respuesta entera. **El fallo era la redacción.** Queda
como regla escrita: todo lo que una herramienta mete en el contexto puede acabar
citado por el modelo, así que una herramienta que no respalda hechos no puede
escribir palabras que parezcan uno.

---

## 5. Excepciones — qué falta y por qué no es código

### 5.1 Pentest externo (T5.36) — entregable humano

Anticipado como tal en el backlog, igual que T3.16 y T4.31. Hay superficie que
atacar desde T5.08–T5.14: tienda pública, links de pago, tracking, webhooks de
pasarela y de marketplace. **Bloqueado por DT-02**: no hay entorno donde
desplegarlo.

**Alcance sugerido, ya acotado:** los cinco escapes de RLS (ADR-0014/0016/0017),
el webhook de pagos (firma, reenvío, importe), los tokens públicos
(`pub_tokens`: enumeración, caducidad, revocación), el aislamiento por `Host` de
la tienda y el agente (inyección de prompt contra las herramientas).

### 5.2 Gate de negocio: 3 operadores piloto — entregable humano

La fase lo exige **antes de cerrar F5** y no depende de este backlog. Requiere
DT-02 resuelto. Es, con diferencia, lo que marca el calendario.

### 5.3 Canario operativo — parcial, y la parte que falta es infraestructura

Lo que garantiza el criterio real —**revertir sin tocar la base**— está hecho y
bloquea en CI:

- `infra/scripts/check-migrations.mjs`: rechaza `DROP COLUMN`, `DROP TABLE`,
  renombrados, cambios de tipo y `NOT NULL` sin `DEFAULT`. Las contracciones se
  declaran (`-- fase: contract` + `-- expande: <migración>`).
- `GET /api/v1/health/ready`: da por **listo** un esquema *por delante* del
  código, que es el estado exacto tras revertir. La regla es una desigualdad, no
  una igualdad.

Lo que falta es el balanceador, el reparto de tráfico al 10 % y el pipeline de
CD. Es infraestructura cloud → **DT-02**.

### 5.4 Lighthouse móvil ≥ 85 — medición humana

El presupuesto de JS bloquea el build y está en **106 KB de 200**, medido
comprimido. La puntuación completa de Lighthouse depende de la máquina: en CI da
falsos rojos o hay que aflojar el umbral hasta que no signifique nada. Se mide
una vez sobre el despliegue real (DT-02) y se anota aquí.

### 5.5 Demos grabadas — arrastradas desde F3

Siguen pendientes. No son código.

---

## 6. Preguntas abiertas que este gate no cierra

| Id | Pregunta | Por qué importa ahora |
|---|---|---|
| **PA-04** | `ORDER_BRAND_NOT_SERVED` no está en el catálogo de la spec 05 §9 | La tienda ya lo convirtió en un error que **puede llegarle a un comprador**, y un código publicado no se cambia sin romper integraciones |
| **PA-05** | No hay error de «local cerrado»; un pedido entra fuera de horario | Alcanzable desde canales propios |
| **PA-06** | ¿A cuántos soles equivale un crédito de IA? | La analítica publica el coste **en créditos** porque no hay tarifa; ponerle una en el código sería inventar el dato que el dueño leería como su factura |
| **PA-07** | La tienda no captura DNI/RUC | La boleta de una venta web la tiene que emitir una persona |

---

## 7. Veredicto

**APTO CON EXCEPCIONES.**

Todo el software de la fase está entregado y verificado contra infraestructura
real. Las cuatro excepciones —pentest, pilotos, canario completo y Lighthouse—
comparten causa: **DT-02, no hay entorno cloud.** Es la deuda que hay que saldar
antes que ninguna otra, y a estas alturas ya no bloquea una tarea: bloquea el
cierre de la fase.

La deuda **DT-08** vencía en este gate y **se saldó**: ADR-0018 adopta
Playwright, acotado a `apps/web`, y el job `browser` bloquea en CI.

---

## 8. Revisión del 9 de agosto de 2026 — lo que apareció después de firmar

Un gate no es un acta: es una foto. Esta sección es lo que se vio al mirar otra
vez, y el motivo por el que la primera foto salió movida.

### 8.1 Lo que el gate original no vio, y por qué

Los ocho criterios de salida de la fase, los siete comunes y las 37 tareas del
backlog estaban todos verificados — y aun así **el sistema no se podía usar**:
no existía ni una sola pantalla de operación. Ni panel de administración, ni
POS, ni KDS. Estaban especificados (`specs/ux/`), asignados a F4–F5, y **ningún
backlog los incluyó**. El gate no lo detectó porque comprueba lo que el backlog
declara —pruebas, cobertura, criterios— y no **la superficie de las specs**.

Es la misma forma de error que este proyecto ya ha visto seis veces a menor
escala: la pieza existe, está bien hecha, y no está conectada a nada. Aquí lo
que faltaba no era una llamada: era la mitad de arriba del producto.

Lo mismo con los datos: `specs/03` pide «CRUD empresas/marcas/locales…» y
`specs/04` «CRUD completo», y de ambas solo se había construido **la mitad de
LECTURA**. Crear una marca exigía SQL a mano; el único negocio que existía era
la pollería ficticia de las semillas demo.

### 8.2 Deuda saldada desde el gate

| ID | Qué era | Cómo se pagó |
|---|---|---|
| **DT-09** | No existía ninguna interfaz: ni panel, ni POS, ni KDS | Panel Next.js (`apps/web/panel`) con sesión en cookies `httpOnly`; PWA de POS y KDS (`apps/pos`, ADR-0019) con IndexedDB, service worker propio y sesión por dispositivo + PIN, vendiendo y cobrando **sin red** |
| **DT-10** | No había forma de crear datos de negocio | `OrganizationAdminService` y `CatalogAdminService` con `If-Match` sobre `row_version`, idempotentes por clave natural, más `setup-business` para dar de alta un negocio entero desde un archivo |
| **DT-11** | El KDS no podía deshacer | Transición inversa `resume_preparing` en el dominio, `undoTicket` con ventana de 30 s y auditoría |
| **DT-04** | La bandeja de excepciones tenía API y no pantalla (venció en este gate) | `/panel/excepciones` con su detalle: carta resuelta **para el canal del pedido**, modificadores obligatorios y opción de recordar el SKU |
| **DT-15** | El centro de operaciones no existía — **y sin él no había forma de aceptar un pedido** | `/panel/operaciones` con las tres columnas de `specs/ux/05` y la cuenta atrás real hasta el rechazo automático |
| **DT-14** | La bandeja de conversaciones no existía — una derivación bot→humano no llegaba a nadie | `/panel/conversaciones` con el resumen del bot antes que el hilo y la ventana de 24 h respetada |

### 8.3 Defectos de producción encontrados al construir esas pantallas

Todos de la misma familia —construido y sin conectar— y todos con consecuencia
en dinero o en servicio:

- **`authenticateDevice` no tenía ningún llamador HTTP.** Una tablet emparejada
  no tenía forma de autenticarse: el POS no podía existir.
- **`GET /auth/me` exigía `tenant.read`**, un permiso que un cajero no tiene. El
  POS iniciaba sesión y recibía 403 en su primera llamada.
- **Ninguna venta del POS llegaba a `cash_movements`.** Cada turno cerraba con
  un sobrante exactamente igual a lo vendido en efectivo, y el arqueo —que
  existe para detectar diferencias— las producía él mismo.
- **`paymentMethod` se descartaba en el borde**: el esquema de zod no lo
  declaraba, así que el campo llegaba y se perdía en silencio.
- **La precuenta impresa no cuadraba**: base + IGV daba un céntimo menos que el
  total cobrado.
- **La mitad SALIENTE de las integraciones no tenía llamador** (§8.4).

### 8.4 El sexto caso, y la comprobación que lo cierra

`ChannelConnector` tiene dos mitades. La de entrada se cableó en F4. La de
salida —`pushMenu`, `setAvailability`, `updateOrderStatus`, `cancelAck`— estaba
implementada en el simulador, con pruebas en verde, y **no la llamaba nadie**.
En un local eso es literalmente lo que RN-INT-05 advierte: se pausa un plato
agotado y el marketplace lo sigue vendiendo.

Ya hay consumidor (`ChannelSyncService`), con 11 pruebas que recorren el camino
completo —evento en `outbox` → `consumeEvent` → conector— y no el servicio a
solas, porque el servicio nunca estuvo mal: lo que faltaba era el eslabón.

Y para que no haya un séptimo, `apps/api/src/workers/wiring.test.ts` vigila
ahora **las tres** formas de quedarse sin llamador: barrido declarado sin
arrancar, módulo con handlers sin registrar en el worker, y **evento publicado
sin consumidor** —que rompe el build salvo que quede justificado por escrito,
con la lista de excusas auditándose a sí misma para que no crezca hasta dejar
de significar nada—. La cuarta comprobación es la simétrica: un handler cuyo
evento nadie publica, que es una errata que de otro modo no falla jamás.

### 8.4b El repaso de `specs/ux/`: faltaban DOS pantallas más

Aplicado el método que destapó DT-09 —leer la lista de specs con interfaz
declarada y preguntar una por una si existe—, de seis specs de UX había cuatro
construidas y **dos que no existían en absoluto**:

- **Centro de operaciones** (`ux/05`, F4 básico / F5 completo). El efecto no era
  estético: **no había forma de aceptar un pedido desde ninguna interfaz**. Los
  canales con aceptación manual dependían de que alguien llamara al endpoint a
  mano y, a los diez minutos, el barrido de RN-ORD-04 los rechazaba solo. Todo
  pedido manual acababa rechazado por falta de un botón.
- **Bandeja de conversaciones** (`ux/06`, F5). Una derivación bot→humano no
  llegaba a nadie: el agente escribía el resumen, marcaba `handoff_at` y ahí
  moría.

Las dos existen ya. Con ellas, **las seis specs de `specs/ux/` tienen
pantalla**.

### 8.4c El mismo defecto, tres veces, en tres módulos distintos

Construir esas pantallas destapó tres instancias del mismo fallo: **un dato que
se guarda con un comentario explicando para qué, y que ninguna ruta devuelve.**

| Dato | Se escribe desde | Para qué, según su propio comentario | Quién podía leerlo |
|---|---|---|---|
| `mapping_failed.data.rawPayload` | F4 | «sin él, resolver la excepción sería adivinar» | nadie |
| `cnv_conversations.handoff_summary` | T5.28 | el traspaso con contexto (RN-CNV-02) | nadie |
| modificadores en `resolve-mapping` | F4 | mapear un plato con talla obligatoria | no había formulario |
| `ord_order_lines` | F4 | el **snapshot** de lo vendido (RN-ORD-02) | nadie — encontrado aplicando §8.8 |

El cuarto lo encontró el propio criterio de §8.8 en su primera aplicación: las
líneas del pedido se guardaban desde F4 y ninguna ruta las devolvía, así que
quien atendía «¿dónde está mi pedido?» veía el estado y el total pero no **qué
pidió el cliente**.

Ninguno lo detectó una prueba porque todas las pruebas llamaban a los servicios
directamente. Es la misma familia que las seis piezas sin llamador de §8.3, con
una diferencia: aquí lo que falta no es el llamador sino **la salida**.

### 8.5 Deuda nueva

| ID | Qué es | Vence |
|---|---|---|
| **DT-12** | El número de pedido del papel del POS es un correlativo del dispositivo, marcado como provisional: se imprime antes de sincronizar y el definitivo lo pone el servidor | Antes del primer piloto |
| **DT-13** | Tres reglas (RN-ORD-04, RN-BIL-02, RN-BIL-03) piden **avisar a una persona** y el aviso muere en un evento sin oyente. El hecho queda registrado y se ve entrando al panel; falta que el panel te busque a ti | F6 |

### 8.6 Cifras a 9 de agosto de 2026

| Suite | Antes del gate | Hoy |
|---|---|---|
| `@sahana/domain` | 438 | **441** |
| API (integración contra Postgres + Redis reales) | 573 | **633** |
| `@sahana/print-agent` | 117 | **117** |
| `@sahana/ai-prompts` | 7 | **7** |
| `@sahana/pos` | — | **23** |
| `@sahana/web` (nuevo: plazos de la torre) | — | **7** |
| Navegador | 6 (tienda) | **20** (tienda + panel) |
| **Total** | **1 141** | **1 251** |

Aislamiento de tenant: **67 casos** bloqueantes. dependency-cruiser: **380
módulos, 1 317 dependencias, 0 violaciones**. Migraciones: **31**, todas
admiten volver a la imagen anterior.

### 8.7 El veredicto no cambia, pero la lección sí

Sigue siendo **APTO CON EXCEPCIONES**, y las excepciones siguen siendo las
mismas cuatro con la misma causa (DT-02). Lo que cambia es qué se le pide a un
gate: **comprobar el backlog no es comprobar la fase**. Un backlog puede estar
completo y dejar fuera media spec sin que ningún criterio se ponga rojo — pasó
tres veces (DT-09, DT-14, DT-15) y las tres se descubrieron leyendo, no
fallando.

### 8.8 Criterio de entrada de F6 (obligatorio antes de abrir la fase)

Se ejecuta **antes** de mirar una sola prueba, y en este orden:

1. **Superficie de spec.** Para cada `specs/modules/*.md` y `specs/ux/*.md` con
   alcance en la fase que se cierra: ¿existe la API? ¿existe la pantalla? Una
   spec con interfaz declarada y sin pantalla es un agujero, no alcance
   pendiente — el alcance pendiente está escrito en la fase siguiente.
2. **Superficie de salida.** Para cada dato que se escribe con un comentario
   que explica para qué sirve: ¿hay una ruta que lo devuelva? Los tres casos de
   §8.4c habrían caído aquí.
3. **Cableado.** `apps/api/src/workers/wiring.test.ts` ya lo automatiza para
   barridos, consumidores y eventos, y bloquea en CI. Nada que hacer a mano.
4. Y solo entonces, los criterios comunes de `specs/phases/_gates-comunes.md`.

Lo que queda del panel son secciones que `specs/ux/03` enumera y que aún no
existen —Pedidos con buscador y timeline, Inventario, Caja y comprobantes,
Clientes, Configuración completa, Novedades—. Todas son de **consulta** y
ninguna bloquea operar, que es la diferencia con las tres que sí eran agujeros.
