# Avance del proyecto

Paquete: **v1.0 consolidado** (2026-08-06). Estados: Pendiente / En análisis / Propuesta / Aprobada / En ejecución / Bloqueada / Finalizada.

| Elemento | Estado | Nota |
|---|---|---|
| Fase 0 — Investigación | Finalizada | Doc maestro v0.1 + revisión comité v0.2 + anexos C/D |
| Fase 1 — Definición de producto | Propuesta | docs/00–07; validar con entrevistas (DP-08) |
| Fase 2 — Arquitectura base | Propuesta | ADR-0001..0015; pendientes de F2: threat model STRIDE + fichas docs/repositories/ |
| ADR-0006 (stack) | **Aceptada** | DP-01 resuelto: la ejecución es en TypeScript/NestJS. Reversa solo si el equipo humano es de perfil PHP (§8) |
| ADR-0013 (Money escala 4) | Aceptada | Representación interna de `Money` documentada e implementada |
| ADR-0014 (escapes acotados de RLS) | Aceptada | Patrón para relay de outbox y resolución de login sin romper el aislamiento |
| ADR-0015 (geometría en el dominio) | Aceptada | Cobertura y horarios compartidos servidor/cliente en vez de PostGIS; divergencia de la spec 03 registrada |
| **Fase 3 — Fundamentos** | **En ejecución** | Negocio y observabilidad completos, verificados contra Postgres real (**198 pruebas en verde**: 101 API + 97 dominio). Queda T3.16 (Terraform) y el gate T3.18 |
| **Fase 4 — Operación principal** | **Propuesta (gate emitido)** | Backlog aprobado (32 tareas). Hecho: T4.01–T4.22 (totales, catálogo versionado con diff, pedidos con dedupe, modificación con control optimista, aceptación automática con vencimiento, bandeja de excepciones resoluble, simulador de marketplace con **prueba de caos de cero pérdida**, **KDS con el ciclo de eventos cerrado**, **caja con arqueo y descuentos con PIN** y **sincronización offline con sus dos pruebas bloqueantes**). Hecho también T4.23–T4.29 (**print-agent instalable**, **food cost real**, **facturación electrónica** con correlativo sin huecos, **avisos por WhatsApp** y **rentabilidad por marca y canal conciliada con Billing**). Hecho T4.30 (**carga con k6**: pico 10× de 15 min con **cero pérdida verificada contra Postgres**), que además destapó que **nadie procesaba los webhooks de marketplace en producción**. Hecho T4.32 (**gate F4**: `docs/32-gate-fase-4.md`, apto con excepciones). **837 pruebas en verde** (315 dominio + 405 API + 117 print-agent), **0 vulnerabilidades altas** y SCA bloqueante. Falta solo T4.31, que es entregable humano |
| **Fase 5 — Venta digital** | **En ejecución** | Backlog de 37 tareas (T5.00). Hecho **T5.01–T5.07: el bloque de pagos online, completo**, con el webhook firmado como única vía de confirmación (RN-PAY-01), deduplicación por restricción de base de datos e importe verificado contra el esperado. Cuarto escape acotado de RLS, sobre credenciales y nunca sobre importes (ADR-0016); y **quinto y último de su especie** (ADR-0017), un mecanismo de tokens públicos que absorbe los enlaces de pago, el tracking de T5.16 y lo que venga. Orden por dependencia real: pagos antes que tienda (un storefront sin pasarela es una demo), bandeja antes que agente IA (el agente escribe EN una conversación), plataforma `ai` antes que agente. Corazón de la fase: **T5.03** (el pedido se confirma SOLO por webhook verificado, nunca por redirect) y **T5.24** (validador anti-precio-inventado), ambos con prueba adversarial |
| Fases 6–9 | Pendiente | Backlog se genera al abrir cada fase (TX.00) |

## Fase 3 — Backlog (estado por tarea)

| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| T3.01 | Monorepo pnpm + tsconfig + ESLint/Prettier + dep-cruiser | **Finalizada** | `pnpm lint`/`typecheck`/`depcruise` en verde; regla anti-`number` monetario activa |
| T3.02 | docker compose (Postgres 16, Redis, Mailhog) + Makefile | **Finalizada** | `docker compose config` OK; healthchecks; init de roles |
| T3.03 | `@sahana/domain`: Money (half-up RN-T04) + property tests | **Finalizada** | 49 pruebas; **100% de ramas en dinero**; IGV RN-T05; máquina de estados base |
| T3.04 | apps/api NestJS + config tipada + logger + Problem Details | **Finalizada** | `GET /api/v1/health` 200 con `trace_id`; 404 → `application/problem+json` |
| T3.05 | Drizzle + RLS `withTenant` + pool modo transacción | **Finalizada** | **Fuga ×1000 en verde** (misma conexión, tenants alternados) |
| T3.06 | Test de esquema: tenant_id + RLS en toda tabla de negocio | **Finalizada** | Suite `schema-rls` en verde; falla si una tabla nueva no cumple |
| T3.07 | Módulo Tenancy (spec 01) | **Finalizada** | `GET /tenant`, `/limits`, `/flags`; límites con cerrojo `FOR UPDATE` (429); suspensión bloquea login sin borrar datos |
| T3.08 | Módulo Identity (spec 02): JWT + roles con ámbito | **Finalizada** | argon2id, refresh rotativo con **revocación de familia por reuso** (RN-IDN-02), guard `@RequirePermission` global, matriz permiso×rol testeada |
| T3.09 | Dispositivos POS + PIN argon2 | **Finalizada** | Emparejamiento con código de un solo uso (garantizado por BD), token de dispositivo revocable, PIN argon2id con **bloqueo 5/15 min que persiste** y cambio obligatorio al primer uso |
| T3.10 | Módulo Audit (spec 17): append-only + interceptor | **Finalizada** | `recordAudit()` transaccional + `GET /audit` con `audit.read`; UPDATE/DELETE fallan en BD (probado). Interceptor automático llega con los módulos de F4 |
| T3.11 | Outbox/inbox + relay (ADR-0007) | **Finalizada** | **Exactamente-una-vez** verificado bajo kill del relay; el **worker** (`make worker`) lo dispara cada segundo y publica a BullMQ, con `jobId` = id del evento para que republicar no duplique trabajo |
| T3.12 | Módulo Organization (spec 03) + zonas de cobertura | **Finalizada** | Jerarquía completa con **FKs compuestas** (docs/09 §4); M:N marca⟷cocina; `GET /coverage` con **punto en frontera**; horario que cruza medianoche; semilla demo de aceptación |
| T3.13 | Harness de aislamiento por endpoint reutilizable | **Finalizada** | `assertEndpointIsolation` recorre la respuesta entera buscando cualquier dato del tenant ajeno; aplicado a los 12 endpoints; incluye prueba del propio detector |
| T3.14 | OTel + Prometheus + dashboards | **Finalizada** | Trazas OTLP, `/metrics` Prometheus con métricas de negocio, y el **gate demostrado**: el `trace_id` sobrevive el salto request→outbox→worker |
| T3.15 | CI/CD completo | **En ejecución** | Workflow GitHub Actions (static, domain, integration con **Postgres + Redis**, build, SCA) |
| T3.16 | Terraform dev | **No entregada** | Definible pero **no verificable sin credenciales cloud**; entregar IaC nunca ejecutada es el artefacto que más caro sale al fallar. Dueño: propietario (docs/31 §3.1) |
| T3.17 | Onboarding tenant demo < 60 s | **Finalizada** | Script mide **50 ms** (gate < 60 s) |
| T3.18 | Gate F3: criterios de salida + demo grabada | **Propuesta** | Evaluación completa en `docs/31-gate-fase-3.md`: **apto con excepciones** (T3.16 y demo grabada, ambas con dueño humano) |

## Fase 4 — Backlog (estado por tarea)

Backlog completo (32 tareas) en `specs/phases/phase-4-operacion.md`. Aquí solo el estado.

| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| T4.00 | Backlog de la fase | **Finalizada** | `specs/phases/phase-4-operacion.md` |
| T4.01 | Entidades de catálogo (spec 04) | **Finalizada** | Migración `0008_catalog.sql`; jerarquía categoría→producto→grupo→opción con FKs compuestas |
| T4.02 | Modificadores y combos en `@sahana/domain` | **Finalizada** | `validateAndPriceModifiers` con códigos de error estables; definición de grupo validada |
| T4.03 | Precios por canal y sucursal | **Finalizada** | `resolvePrice` por especificidad ((canal,sucursal) > canal > base); índice único con `COALESCE` |
| T4.04 | Cálculo de totales (RN-T01..T05) | **Finalizada** | Redondeo half-up solo en el total; IGV extraído hacia atrás; propina fuera de base imponible; **100 % de ramas** |
| T4.05 | Disponibilidad y pausas de producto | **Finalizada** | `POST /catalog/products/:id/pause` emite `catalog.availability_changed` por outbox; pausas caducadas se levantan solas |
| **T4.06** | **Publicación versionada del catálogo** | **Finalizada** | Versión **inmutable** (UPDATE/DELETE revocados en BD) y descargable por (marca, canal), con correlativo propio; republicar sin cambios reutiliza la versión existente en vez de duplicarla; **diff entre versiones** calculado en `@sahana/domain` (property test: aplicarlo reconstruye siempre el destino) para que el POS sincronice sin bajarse el catálogo entero; **publicar no bloquea ventas**, verificado con 12 pedidos y 3 publicaciones concurrentes |
| **T4.07** | **Máquina de estados de pedido** | **Finalizada** | 12 estados × 13 eventos: **las 156 combinaciones** probadas (transicionan o lanzan); BFS de alcanzabilidad; sin callejones sin salida |
| T4.08 | `OrderingService.submit()` + `ord_*` con snapshot inmutable | **Finalizada** | Migración `0009_ordering.sql`; la línea copia nombre y precio (no referencia a `cat_prices`); timeline append-only verificado en BD |
| T4.09 | Idempotencia y dedupe (ADR-0010) | **Finalizada** | **Dedupe concurrente en verde**: dos `submit()` simultáneos con el mismo `external_ref` → 1 pedido (garantía del índice único, no del código) |
| **T4.10** | **Validaciones de submit (RN-ORD-09)** | **Finalizada** | Marca activa en cocina del local + disponibilidad + cobertura + mínimo, cada una con su **código estable** de Problem Details (spec 05 §9) |
| **T4.11** | **Transiciones + API de pedidos + timeline** | **Finalizada** | `PATCH /orders/:id` con `If-Match` sobre `rowVersion`; la modificación **añade líneas de ajuste y no reescribe las confirmadas** (RN-ORD-07); 409 en transición inválida; timeline reconstruible |
| **T4.12** | **Aceptación automática/manual con vencimiento y programados** | **Finalizada** | Política por (marca, canal) resuelta por especificidad; el pedido con auto-aceptación **nace aceptado en la misma transacción**; aviso a los 5 min sin repetirse (UPDATE condicional: seguro con varias instancias del worker) y auto-rechazo a los 10 con timeline y evento al canal; programado liberado a `prep_minutes + 10` |
| **T4.13** | **Bandeja de excepciones + `resolve-mapping`** | **Finalizada** | `POST /orders/:id/resolve-mapping` recalcula el pedido apartado con el catálogo vigente y lo devuelve al flujo; permiso `orders.review_exceptions`; resolver dos veces → 409 |
| **T4.14** | **Simulador de marketplace (spec 13)** | **Finalizada** | `ChannelConnector` + simulador **reproducible por semilla**; ack < 250 ms medido; firma HMAC sobre el cuerpo crudo; credenciales cifradas por tenant (AES-256-GCM + HKDF, tenant como AAD); cortacircuitos por conexión |
| **T4.15** | **Prueba de caos de ingesta** | **Finalizada** | **Cero pérdida verificada matando el worker con `pg_terminate_backend`** a media faena, 6 rondas: todo webhook con ack acaba en pedido o en `needs_review`, sin duplicados, sin cola de muertos y sin cerrojos zombis |
| **T4.16** | **KDS: cocina ve los pedidos** | **Finalizada** | Migración `0013_kitchen.sql`; **un ticket por estación** con snapshot de sus líneas; el pedido pasa a `ready` solo con TODOS los tickets listos (RN-KIT-02); empaque con checklist obligatorio y **etiqueta con la marca correcta verificada con dos marcas simultáneas**; `GET /kitchen/load`. **Cierra el ciclo de eventos**: consumidor BullMQ con `inbox` en la misma transacción que el efecto (exactamente-una-vez efectivo). **SLO medido**: aceptado → visible en cocina < 5 s por el camino completo |
| **T4.17** | **Sesiones de caja y movimientos** | **Finalizada** | Migración `0014_cash.sql`; UNA sesión abierta por terminal (índice único); movimientos **append-only** (UPDATE/DELETE revocados, probado); un pedido no se cobra dos veces; salida de efectivo sin motivo rechazada; **las ventas con tarjeta no cuentan como efectivo en gaveta** |
| **T4.18** | **Arqueo y cierre con diferencia** | **Finalizada** | El esperado se **calcula** sumando movimientos y se **congela** al cerrar; diferencia ≠ 0 exige motivo **y** PIN de supervisor (reutiliza el bloqueo por intentos de F3) → auditoría con el motivo y quién aprobó; la restricción también está en la BD (`diferencia_justificada`) |
| **T4.19** | **Descuentos con PIN sobre umbral** | **Finalizada** | Decisión en `@sahana/domain` para que el POS offline llegue a la misma conclusión; compara el **acumulado** y no el descuento suelto — cubre el fraude de encadenar descuentos pequeños, con property test; umbral por porcentaje **y** por importe |
| **T4.20** | **Cola local offline (motor)** | **Parcial** | `SyncQueue` en `@sahana/domain`: ULID de cliente como clave natural, orden de venta, backoff **con tope**, recuperación de lo que quedó «en vuelo» al cerrarse el navegador, y **cierre de caja bloqueado con ventas pendientes**. Property test: ninguna venta encolada desaparece jamás. **Falta la UI React + binding a IndexedDB** (ver nota) |
| **T4.21** | **Sincronización offline (RN-T07)** | **Finalizada** | `POST /orders/sync` idempotente por ULID; **nunca rechaza**: producto retirado, precio cambiado o total discrepante entran igual y generan alerta en el timeline y en auditoría; prevalece siempre el importe del ticket. **Prueba bloqueante en verde: 20 pedidos sin red → 20 en servidor con totales idénticos** (Money del POS vs servidor) |
| **T4.22** | **Corte de red a mitad de sincronización** | **Finalizada** | **Prueba bloqueante en verde**: 5 de 10 procesados, respuesta perdida, reenvío del lote entero → 5 duplicados detectados y **exactamente 10 pedidos en la base** |
| **T4.23** | **print-agent v1: ESC/POS, cola propia y reintentos** | **Finalizada** | `apps/print-agent`: servicio Node local que **sí habla ESC/POS** (ADR-0008 — sin él el POS offline no existe). Codificación **CP850, no UTF-8** (una térmica que recibe UTF-8 imprime «RaciÃ³n»), con degradación ordenada a «Racion» antes de rendirse a `?`. Tickets construidos y probados **byte a byte**: es la única forma de verificarlos sin la impresora delante. Cola **persistida en disco antes de intentar imprimir**, con escritura atómica; lo que quedó a medias en un corte de luz vuelve a la cola al arrancar, y **nada se descarta jamás** (agotado ≠ perdido: sigue reimprimible). API **solo en 127.0.0.1** con token comparado en tiempo constante — el wifi de un local no es red de confianza. **72 pruebas** + arranque real verificado (comanda impresa, 401 sin token, apagado limpio ante SIGTERM) |
| **T4.24** | **Instalador del print-agent** | **Finalizada (con entregable humano declarado)** | `install.sh` (systemd) e `install.ps1` (servicio de Windows) + desinstaladores. Valida TODO antes de tocar nada —abortar a medias deja una máquina que nadie sabe deshacer—, diagnostica (`main.js doctor`), arranca **esperando a que el servicio responda de verdad** y **termina imprimiendo una página de prueba**: «el servicio arrancó» no prueba nada, arranca igual con la impresora apagada. La página no dice «OK», ejercita acentos, ancho real con regla numerada, tamaños y corte — y **ninguna de sus líneas puede desbordarse** (probado a 32/42/48 columnas), porque si se desborda ya no distingue «ancho mal configurado» de «texto largo». Ciclo completo verificado en este contenedor: instalar → diagnosticar → arrancar sin `node_modules` → imprimir a 32 y 48 columnas → desinstalar conservando pendientes → `--purge`. Además `/printers/discover` (asistente de docs/26 §3) y `doctor`. **117 pruebas** en el agente |
| **T4.25** | **Recetas y consumo automático de stock** | **Finalizada** | Migración `0015_inventory.sql` (extiende `org_warehouses`, no duplica). `Quantity` en `@sahana/domain` —mismo criterio que `Money`: entero a escala 4, mermas en **puntos básicos** y no en decimal, y la **unidad dentro del valor** para que sumar gramos con mililitros no compile—. Estallido con **subrecetas de rendimiento propio**, ciclos detectados **nombrando el camino** y tope de 3 niveles (RN-INV-05); **combo consume por componentes** (RN-CAT-04). Kardex **append-only** (UPDATE/DELETE revocados, probado) con stock materializado encima; **negativo permitido con alerta** (RN-INV-02: jamás se bloquea una venta). Reversa **exacta** invirtiendo lo escrito, y merma con motivo si ya se preparó (RN-INV-03). Pruebas de la spec en verde: subreceta anidada por el camino real de eventos · reversa que suma cero · negativo con alerta y pedido igualmente aceptado · **50 pedidos simultáneos del mismo insumo con stock final exacto** · aislamiento en los 3 endpoints nuevos |
| **T4.26** | **Facturación: adaptador OSE en sandbox + correlativo sin huecos** | **Finalizada** | Migración `0016_billing.sql`. El comprobante **nace sin número** y el correlativo se toma **al emitir**, bloqueando la fila de la serie con `FOR UPDATE` (RN-BIL-01). **Prueba bloqueante en verde: 40 emisiones simultáneas → 40 correlativos consecutivos, sin duplicados y sin huecos.** Una vez asignado, el número **es de ese documento para siempre**: los reintentos reenvían el mismo — devolverlo al pozo es justo lo que crea el hueco cuando el reintento sí funciona, y un hueco hay que justificarlo ante SUNAT con una comunicación de baja. Sandbox OSE **reproducible** con rechazos por código del catálogo, caídas y **respuestas perdidas**; rechazado → cola de corrección con la venta intacta (RN-BIL-02); bitácora de envíos **append-only** para poder reclamar con datos |
| **T4.27** | **Emisión diferida cuando hay corte** | **Finalizada** | La fecha de emisión es la de la **VENTA**, no la del envío (RN-BIL-03): contarla desde el envío haría que un documento con tres días de retraso pareciera recién nacido. Cola despachada **de lo más antiguo a lo más nuevo** —el viejo es el único que puede vencer— con aviso a las 48 h de 72 y **sin repetirlo en cada vuelta** del worker. El barrido de todos los tenants va cableado al worker (`billing-queue` cada 30 s): sin eso, un comprobante offline esperaría a que alguien pulsara «reintentar» a mano mientras el plazo corre. Nota de crédito con referencia al original y auditoría |
| **T4.28** | **WhatsApp: notificaciones de estado** | **Finalizada** | Migración `0017_whatsapp.sql`. La decisión de **texto libre vs plantilla** vive en `@sahana/domain`: dentro de la ventana de 24 h el texto libre es gratis y usar plantilla es pagar de más en cada pedido; fuera, Meta descarta el texto libre y el cliente no se entera de que su comida salió. La ventana se cuenta desde el mensaje **ENTRANTE** —desde el saliente estaría abierta para siempre— y el tipo ni siquiera admite un `lastOutboundAt`. **Opt-out inmediato y persistente** (RN-WA-04): se mira antes que la ventana, y responder «BAJA» da de baja en el acto. Consentimiento **append-only con el texto exacto** (RN-T10, Ley 29733): un `accepts_marketing` booleano no demuestra qué aceptó nadie. Solo se notifican 6 estados de los 12: avisar de «empacado → despachado» multiplica el costo sin decir nada útil. Pruebas de la spec en verde: ventana expirada → plantilla · opt-out respetado · **dedupe del webhook** · **WhatsApp caído → el pedido sigue** · KPI de mensajes por pedido |
| **T4.29** | **Analítica: rentabilidad por marca y canal** | **Finalizada** | Migración `0018_analytics.sql`. Lee de **proyecciones alimentadas por eventos, nunca de las tablas transaccionales en caliente** (regla de la spec 16): un `GROUP BY` sobre `ord_orders` a las 20:30 de un viernes compite por las filas que están cerrando pedidos, y hay prueba de que sin drenar el outbox la proyección no se mueve. Se guardan los **sumandos**, no el margen: se calcula al leer, con `Money`. Granularidad (día de NEGOCIO en zona del local, marca, canal, local) — un pedido de las 23:40 en Lima es del día 7, no del 8. Las cancelaciones se cuentan aparte para no ensuciar el ticket promedio, y la comisión **liquidada** manda sobre la estimada (RN-BIL-04). **Conciliación con Billing en verde**, que la spec declara bug crítico si diverge: cuadra importes Y detecta ventas sin comprobante |
| **T4.30** | **Pruebas de carga con k6** | **Finalizada** | Perfil de docs/06, no estimado: **5,56 pedidos/s durante 15 min** (pico 10× del sostenido de 2 000/hora). `constant-arrival-rate` y no usuarios virtuales — con VUs, si la API se pone lenta el generador manda MENOS carga y la prueba se ablanda justo cuando debería apretar; por eso `dropped_iterations` es un umbral. El gate es **doble y separado a propósito**: k6 mide (p95 de submit) y `verify-zero-loss.mjs` juzga contra Postgres (outbox = pedidos, DLQ = 0). Una API puede devolver 201 a cinco mil pedidos, haber perdido cien por el camino y sacar percentiles preciosos: k6 no habla con la base y no puede saberlo. Se añadió `ingest-webhooks.js` para el otro camino de entrada (webhook firmado, ack < 250 ms). **Medido: 5 044 pedidos, 0 rechazados, 0 iteraciones perdidas, p95 31,7 ms; ingesta 669 webhooks, 0 fallidos, p95 10,7 ms. Cero pérdida verificada contra la base** |
| **T4.31** | **E2E «día de operación»** | **No entregada** | **Entregable humano**, anticipado como tal en el backlog: exige mini PC, impresora térmica, tablet y una persona cortando internet dos veces con comida en marcha. Las piezas están verificadas por separado; lo que falta es el día real. Dueño: propietario |
| **T4.32** | **Gate F4** | **Propuesta** | Evaluación completa en `docs/32-gate-fase-4.md`: **apto con excepciones** (T4.31, la ejecución del instalador en máquina limpia y la demo grabada, las tres con dueño humano). Saldó de paso una deuda que tocaba tenancy: 9 avisos altos de dependencias, entre ellos **inyección SQL en `drizzle-orm`**; el paso de SCA pasa a BLOQUEANTE |

**Próximas acciones humanas:** confirmar DP-01 (equipo ejecutor) · agendar entrevistas DP-08 · revisar diffs de `infra/migrations/*.sql` · resolver PA-01/02/03 (`docs/22-risks.md`) · **definir `CREDENTIALS_MASTER_KEY` en cada entorno** (sin ella no arranca en producción, y rotarla obliga a recifrar).
**Deuda saldada:** el worker (`apps/api/src/workers/main.ts`, `make worker`) ya dispara el relay del outbox y el barrido de aceptación. Verificado de dos formas: pruebas que ejecutan el mismo `PeriodicJob` de producción contra **BullMQ y Postgres reales** (el evento sale del outbox y llega a la cola), y arranque del proceso completo con apagado limpio ante SIGTERM.

**Alcance declarado de T4.20:** se entrega el MOTOR offline (cola pura en el dominio + protocolo de sincronización + las dos pruebas bloqueantes de la spec 06), no la interfaz. La UI React de `apps/pos` y su binding a IndexedDB quedan pendientes: son plomería sobre una lógica que ya está probada, y entregarlos sin poder ejercitarlos en un navegador real daría una falsa sensación de terminado. Lo que sí está verificado es todo lo que puede romperse en silencio.

**Alcance declarado de T4.23:** el agente imprime por **red (TCP 9100)** y por **fichero de dispositivo**, que en Linux es exactamente cómo se escribe a una térmica USB (`/dev/usb/lp0`). Queda pendiente el **USB nativo en Windows** (necesita un binding nativo) y el **reporte de salud a la nube** de ADR-0008 §3: hoy `/health` lo expone para la PWA, falta que el panel lo reciba. Una impresora configurada con un transporte no disponible no impide arrancar: el trabajo espera en la cola con un error legible.

**Errores reales encontrados y corregidos en T4.23** (los tres los descubrieron las pruebas, no una revisión): el despachador prometía ir «de uno en uno» y no lo cumplía entre llamadas — el bucle de reintentos cada 5 s y el disparo de cada petición de la PWA podían elegir el **mismo trabajo** antes de que ninguno lo marcara, sacando **la comanda por duplicado**; el despacho en segundo plano no tenía `catch`, así que un disco lleno habría tumbado el agente entero por rechazo no gestionado, dejando al local **sin imprimir nada**; y reimprimir un trabajo ya purgado devolvía 500 en vez de 404, mezclando el error del operador con una avería.

**`pnpm format:check` estaba en rojo en CI** desde tareas anteriores (39 ficheros). Corregido en este commit: un gate que falla siempre deja de ser un gate.

**Alcance declarado de T4.24:** las notas de planificación de la fase declaran la ejecución **sobre hardware real** entregable humano. Lo verificado aquí es el **procedimiento completo en Linux** con la impresora simulada como fichero de dispositivo —que es literalmente cómo se escribe a una térmica USB en Linux (`/dev/usb/lp0`)—. `install.ps1` está escrito pero **no ejecutado en Windows**. Sigue pendiente la **auto-actualización firmada** de ADR-0008: hoy actualizar es reejecutar el instalador, que ya es idempotente.

**Decisión tomada en T4.24: el agente se queda con CERO dependencias de ejecución.** El instalador copiaba `dist/` y el agente no arrancaba porque `zod` no estaba: en un monorepo pnpm `node_modules` son enlaces al almacén, así que copiar tampoco vale. Las salidas eran empaquetar con un bundler, bajar paquetes de npm dentro del local o distribuir un tarball aplanado — tres piezas más que pueden fallar en el sitio donde menos podemos ir a arreglarlas. Se sustituyó `zod` por validación escrita a mano (tres formularios de campos simples) y **hay una prueba que impide reintroducir un import externo sin darse cuenta**. Instalar vuelve a ser copiar una carpeta.

**Fallo real encontrado al mirar el papel impreso en T4.24:** dos líneas de la página de prueba se pasaban del ancho, y la misma falta afectaba a las notas de la comanda (`Tocar el timbre dos veces, es la puerta verde`). La impresora las parte por donde le toca —a mitad de palabra— y en la página de prueba eso la invalida entera. Se añadió `wrapped()` al constructor ESC/POS, con sangría en las líneas de continuación para que un modificador partido no se lea como un plato más.

**Dos correcciones de diseño hechas durante T4.25**, ambas detectadas al implementar y no en revisión:

1. **`org_warehouses` ya existía** desde la migración 0005, con el comentario «el stock se consume a nivel cocina/almacén». Había empezado creando `inv_warehouses`: una segunda tabla de almacenes habría partido el inventario en dos mitades que se desincronizan en cuanto alguien dé de alta un almacén por el sitio equivocado. Se extiende la existente con `kitchen_id`.
2. **El motivo de cancelación no viajaba en el evento.** Ordering lo dejaba solo en `audit_log`, así que la merma de inventario quedaba registrada como «sin motivo» — y lo mismo le pasará al aviso por WhatsApp (T4.28). Auditoría se lee después; el evento se consume ahora. Ya va en el payload de toda transición.

**Un endpoint nuevo repetía en su 404 el id que le mandaban**, y el harness de aislamiento lo marcó como fuga. El id lo aporta quien llama, así que no revela nada nuevo, pero la regla del repo es que ninguna respuesta lleve identificadores de otro tenant: se quitó del mensaje.

**Alcance declarado de T4.25:** se entrega la parte de F4 de la spec 08 (insumos, recetas/subrecetas, consumo automático, stock por almacén, mínimos y alertas). Queda para F6 lo que la propia spec sitúa allí: compras, proveedores, transferencias, conteos, producción interna, **costo promedio móvil** (hoy el costo del movimiento es un snapshot del `unit_cost` vigente, que es lo que exige RN-INV-04 para no falsear el margen histórico) y lotes/vencimientos.

**Alcance declarado de T4.26/T4.27:** se corre contra el **sandbox OSE simulado**, como manda CLAUDE.md mientras DP-02 (proveedor OSE, 3 cotizaciones) siga abierto. El proveedor se inyecta por token y el puerto es un anti-corruption layer: cuando DP-02 se cierre, cambiar de OSE es cambiar un `useClass`. Queda fuera lo que la spec sitúa en F5: pagos online (intenciones, webhooks de pasarela, reembolsos) y la conciliación de comisiones liquidadas (RN-BIL-04). Tampoco se genera XML UBL 2.1 ni PDF: los firma y produce el OSE (ADR-0003), y el almacenamiento WORM a 5 años es infraestructura, no código.

**Un ajuste en el harness de aislamiento:** marcaba como fuga el campo `instance` de Problem Details, que por RFC 9457 **es la URI de la petición** — el id ajeno lo pone quien pregunta, no el servidor. Contarlo como fuga obligaría a devolver errores sin contexto en todos los endpoints con `:id`. Se excluye solo ese campo; el `detail` y el resto del cuerpo siguen vigilados, y ahí un id ajeno sí sería el servidor hablando de más.

**Alcance declarado de T4.28/T4.29:** WhatsApp corre contra **simulador local**, como manda CLAUDE.md mientras DP-04 (BSP vs Cloud API directa) siga abierto y falte la verificación de Meta Business. El **webhook real** de Meta llega en F5 con `integrations`, cuando se sepa su forma exacta; hoy la entrada se prueba por el servicio. Queda para F5 el bot de toma de pedido y la derivación a humano. De analítica se entrega lo de F4 de la spec 16 (ventas por canal/marca, ticket promedio, food cost teórico, margen y conciliación); los tiempos de aceptación/cocina/entrega y el servicio Python de F8 quedan fuera.

**Un fallo real que cazó el harness de aislamiento:** `GET /messaging/orders/:id/stats` devolvía **200 con ceros** al pedir el id de un pedido ajeno. RLS impedía la fuga de datos, pero la respuesta no distinguía «no tiene mensajes» de «no es tuyo» — y devolvía el id ajeno dentro del cuerpo. Ahora comprueba que el pedido existe en el tenant y responde 404. Es el mismo patrón que ya apareció en `/kitchen/load`.

**El worker ya monta CUATRO consumidores** (cocina, inventario, mensajería, analítica), cada uno con su propia marca en `inbox` y su propia transacción. Un fallo de uno no deshace el efecto de los otros: el reintento vuelve a pasar por los cuatro y los que ya estaban hechos responden `skipped`.

**El fallo más grave que ha encontrado una prueba hasta ahora, y lo encontró la de carga:** `IngestionService.processPending` existía desde F4, con sus pruebas en verde, y **nadie lo llamaba en producción**. Los webhooks de marketplace se aceptaban con 202, se guardaban en `int_webhook_events` como `pending`… y ahí se quedaban. Un pedido de Rappi habría entrado, el proveedor lo habría dado por recibido y no habría llegado nunca a la cocina. Ninguna prueba lo vio porque todas llamaban a `processPending` a mano: el hueco no estaba en el servicio, estaba en el ARRANQUE. Ahora el worker monta `ingestion-sweep` cada segundo, y `workers/wiring.test.ts` falla si algún `PeriodicJob` se declara sin arrancarse o sin pararse al apagar.

**Un bug de zona horaria en la conciliación, con ventana de fallo en las horas de más venta:** `aFechaNegocio` calculaba el día con `toISOString()` —UTC— mientras la proyección y el filtro de comprobantes usan `America/Lima`. Entre las 19:00 y la medianoche de Lima, `reconcileWithBilling(new Date())` preguntaba por el día siguiente, encontraba cero de los dos lados y respondía **`matches: true`**: un cuadre que solo cuadraba porque no miraba nada, y precisamente cuando una divergencia importa. Apareció porque la suite corrió a la 01:37 UTC; a cualquier otra hora habría pasado en verde. Corregido, con prueba de fecha FIJA. De paso, `?date=2026-01-15` ahora se trata como un DÍA y no como medianoche UTC, que caía en la víspera en Lima.

**Alcance declarado de T4.30:** los números medidos salen de un contenedor donde Postgres, Redis, la API, el worker y el propio k6 comparten cuatro núcleos. Eso da un **suelo** —sirve para detectar regresiones y para saber que el sistema no se cae—, no un SLO. La medición que vale para el gate de fase se hace sobre la infraestructura de destino, y esa necesita el entorno de `docs/17-devops-and-deployment.md` levantado (bloqueado por T3.16, Terraform, que es acción humana). La ingesta se prueba contra el **simulador**, como manda CLAUDE.md: no hay integración real de marketplace en el MVP.

**Una deuda que tocaba TENANCY, saldada en el gate:** la auditoría de dependencias corría en modo informativo desde F3 y había acumulado **9 avisos altos**. Entre ellos, **inyección SQL en `drizzle-orm` por identificadores mal escapados** — el ORM que ejecuta todas las consultas con contexto de tenant. Bajo CLAUDE.md eso no es deuda aceptable bajo ninguna lectura. Subidos `drizzle-orm` 0.38 → 0.45.2 y OTel a la línea 2.x, `multer` y dos transitivos fijados con `pnpm.overrides`: **cero altas**, y el paso de CI pasa de `|| true` a bloqueante. Un gate que nunca falla no es un gate.

**La subida no fue gratis, y por eso se verificó a mano:** Drizzle 0.45 **envuelve los errores del driver**, así que la detección de índice único (`code === '23505'`) dejó de reconocerlos. El síntoma habría sido un cajero viendo un volcado de SQL con parámetros en vez de «esta terminal ya tiene una sesión abierta». Lo cazaron dos pruebas de caja; ahora se recorre la cadena de `cause`. La migración de OTel a 2.x se comprobó arrancando la API compilada con el tracing activo, no solo con `tsc`.

**Tercer fallo que destapó la carga:** un modificador obligatorio sin elegir mandaba el pedido de marketplace a la **cola de muertos** en vez de a la bandeja de excepciones. `ModifierError` vive en `@sahana/domain` y no hereda de `DomainError`, la jerarquía de la API, así que un error del CONTENIDO se trataba como transitorio: cinco reintentos contra un payload que no iba a mejorar. Violaba RN-INT-02 y el criterio de T4.13 —«webhook aceptado → pedido o `needs_review`, nunca otra cosa»— directamente.

**Cobertura de dominio subida donde faltaba, no justificada:** `catalog/` (86,1 %) y `offline/` (89,2 %) entraban al gate por debajo del 90 %. Lo que faltaba no era decorativo: marcar como sincronizado un pedido que ya no está en la cola (pasa al purgar justo antes de que llegue la respuesta) y comparar por contenido un campo que es un objeto (decide si la PWA se baja el catálogo entero en cada publicación). Ahora **97,5 % de ramas global**, ningún módulo bajo 90 %, dinero al 100 %.

## Fase 5 — Backlog (estado por tarea)

37 tareas en `specs/phases/phase-5-venta-digital.md`. Aquí solo el estado.

| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| T5.00 | Backlog de la fase | **Finalizada** | `specs/phases/phase-5-venta-digital.md` |
| **T5.01** | **Adaptador de pasarela + 2 sandbox** | **Finalizada** | Puerto `PaymentProvider` con dos implementaciones que se parecen lo MENOS posible dentro de lo verosímil: distinta cabecera y formato de firma (`hex` pelado vs `ts=…,v1=…`), distinto vocabulario de estados, distinto formato de importe, y una de ellas **no manda identificador de evento**. Dos sandbox gemelos habrían demostrado solo que el código compila dos veces |
| **T5.02** | **Intenciones de pago** | **Finalizada** | Migración `0019_payments.sql`. Estados en `@sahana/domain` y **MONÓTONOS**: las pasarelas reintentan sin respetar el orden, y sin monotonía un aviso tardío de `authorized` desconfirmaría una venta ya entregada. Referencia **opaca**, no el id interno: un identificador que se publica acaba en logs de terceros y en capturas de pantalla |
| **T5.03** | **Webhook de confirmación firmado (RN-PAY-01)** | **Finalizada** | **El pedido se confirma SOLO por webhook verificado**: no hay endpoint de confirmación y hay prueba de que no existe. Dedupe por clave única `(tenant, provider, event_id)` escrita en la MISMA transacción que el efecto. **Importe verificado, no aceptado**: un céntimo de diferencia no confirma y queda registrado. Firma inválida y token inexistente responden **idéntico**, para no servir de oráculo |
| **T5.04** | **Pago confirmado tras el vencimiento → devolución automática** | **Finalizada** | Migración `0020_payments_refunds.sql`. **La marca de devolución se escribe en la MISMA transacción que la captura**, y un barrido la ejecuta después: devolver es una llamada de red a un tercero y el proceso puede morirse entre capturar y devolver — con la marca, ese hueco retrasa la devolución; sin ella, la pierde sin que nadie lo sepa. Dos motivos, mismo hecho: intención vencida o pedido ya rechazado/cancelado. Tras 5 intentos **se rinde y pide ayuda humana** en vez de reintentar en bucle, y **NO se marca como devuelto**: fingir que el dinero volvió sería el peor resultado |
| **T5.05** | **Links de pago** | **Finalizada** | Migración `0021_public_tokens.sql`. **El enlace no lleva ningún id interno**: se reenvía por WhatsApp y acaba en capturas de pantalla, y un id ahí es un id publicado para siempre. Abrirlo devuelve **lo mínimo para pagar y nada más** — ni pedido, ni cobro, ni nombres: quien lo abre puede no ser a quien se lo mandaron. **NO es de un solo uso**, en contra de la primera redacción del backlog: un link que muere al abrirse pierde la venta cada vez que a alguien le suena el teléfono, y lo de un solo uso es el COBRO, que garantiza la máquina de estados |
| **T5.06** | **Reembolsos con doble aprobación (RN-PAY-03)** | **Finalizada** | Sobre el umbral hacen falta **dos personas distintas**: aprobarse a uno mismo se rechaza, porque si no el control es teatro y una sola cuenta comprometida se aprueba sola. El umbral vigente **queda congelado** en la fila: cambiarlo mañana no puede reescribir la historia de una aprobación. El dinero lo devuelve el mismo barrido de T5.04 |
| **T5.07** | **Conciliación de pasarela y comisiones liquidadas (RN-BIL-04)** | **Finalizada** | Migración `0022_settlements.sql`. Cerró un agujero silencioso: `commission_estimated` tenía `DEFAULT 0` y **nadie lo escribía**, y `commission_settled` esperaba a alguien que nunca llegó — el panel de rentabilidad restaba una comisión de cero y **enseñaba el margen bruto llamándolo margen**. Para quien vende por marketplace al 25 %, esa no es una imprecisión: es la diferencia entre creer que ganas dinero y ganarlo. Comisión en **puntos básicos enteros** y redondeo **una sola vez, al final**. Sin tarifa configurada se deja **NULL, no cero**: un cero es indistinguible de «este canal no cobra». Cambiar el tarifario **cierra la tarifa anterior, no la edita** — renegociar en marzo no puede cambiar el margen de enero. La conciliación **reporta y no corrige**: línea sin cobro detrás, cobro sin línea, bruto que no cuadra, comisión fuera de tolerancia (relativa en bps, no en soles) |
| **T5.08–T5.13** | **Tienda web: dominio por marca, carrito de servidor, checkout invitado y cupones** | **Finalizada** | Migración `0023_storefront.sql`. **El tenant sale del `Host`, jamás de un parámetro**: es lo que separa una tienda multi-marca de un buscador de catálogos ajenos, y tiene prueba propia (la marca A no sirve el catálogo de B, ni por contexto, ni por catálogo, ni metiendo un producto de B en un carrito de A). Host **único globalmente** y `status='active'` que exige `verified_at`, las dos reglas **en la base**: son las que impiden secuestrar la tienda de otro registrando su dominio. **El carrito vive en el servidor** — sin eso no hay revalidación (RN-STO-02) ni «pago fallido → carrito recuperable», que son criterios de aceptación, no preferencias. Las líneas **no guardan precio**, al contrario que las del pedido: un carrito es una lista de deseos y el precio se resuelve del catálogo vigente en cada consulta, así un cambio se ve ANTES de pagar; el pedido es un contrato y ahí se congela. **Sin cobertura no es un error: es recojo con motivo** — un error pierde la venta, «no llegamos, pero puedes recoger» la conserva. Consentimiento de marketing **separado y con su texto exacto** (Ley 29733): un booleano no acredita qué aceptó nadie. Cupones sobre el **subtotal**, nunca sobre el envío (descontar del envío regala el margen del repartidor), y **debajo del mínimo se dice cuánto falta**, no solo que no se puede |
| **T5.14** | **Presupuesto de rendimiento móvil** | **Finalizada (la mitad automatizable)** | `apps/web` deja de ser un placeholder. **JS de primera carga: 105-107 KB de 200** en catálogo, ficha de plato, carrito y checkout, y **el presupuesto BLOQUEA el build** — uno que solo se mira a mano se incumple el primer martes con prisa. Ojo con el matiz, que costó descubrirlo: el guion pasaba en verde **sin medir las rutas** hasta que se corrigió la clave del grupo `(tienda)`; ver la sección propia más abajo. Se cumple no metiendo JavaScript: componentes de servidor salvo tres formularios, que además **funcionan sin JS** porque son `<form>` de verdad contra acciones de servidor. Ninguna librería de UI, de estado ni de fetching: cada una cabe de sobra en el presupuesto ella sola. **Lighthouse queda como entrega humana**: la puntuación depende de la máquina, así que en CI o da falsos rojos o hay que aflojar el umbral hasta que no signifique nada |
| **T5.15–T5.17** | **Delivery propio: repartidores, asignación, tracking público y liquidación del cobro contra entrega** | **Finalizada** | Migración `0024_delivery.sql`. **El envío es una entidad aparte del pedido**, con su propia máquina de estados: un reparto fallido no cancela la venta, se reintenta o se devuelve (RN-DLV-03), y al reintentar **suelta al repartidor** — pegado a quien ya falló, el reintento sería el mismo intento otra vez. **No se puede entregar sin haber recogido**: con cobro contra entrega, un toque de más marca cobrado un pedido que sigue en el mostrador. **La zona es un FILTRO, no una preferencia** (ver abajo). El ranking se devuelve **entero y con el motivo en castellano**: en F5 decide una persona, y una recomendación sin explicación no se sigue. **El COD es dinero del repartidor hasta que liquide** (RN-DLV-02): no entra en caja al entregar, y cuando entra lo hace como `cash_in` y no como `sale` —la venta ya se contó al facturar, y contarla otra vez duplica los ingresos del día—. El **tracking público** reutilizó `pub_tokens` (ADR-0017) **sin ningún escape de RLS nuevo**, que era justo para lo que se construyó: estado, ETA y **nombre de pila** del repartidor, solo mientras va en camino |
| **T5.18** | **Capacidad y saturación de cocina — paga DT-03** | **Finalizada** | Migraciones `0025_kitchen_capacity.sql` y `0026_channel_pauses.sql`. **Dos umbrales y no uno**: el primero **extiende la promesa y sigue vendiendo** —un cliente al que le dicen 55 min no se va; uno al que le prometen 35 y llega en 55, sí—; el segundo **pausa canales**, menor margen primero, y solo entonces, porque cerrar canales al primer pico es cerrarse en la mejor hora del día. La decisión es **pura y monótona** (más carga nunca relaja el nivel) y el efecto es **idempotente**: las promesas se mueven solo al EMPEORAR de nivel, porque el barrido corre cada 30 s y extender en cada vuelta acabaría prometiendo la comida para el día siguiente. La reapertura automática **no levanta una pausa manual** —si el encargado cerró Rappi por quedarse sin pollo, que la cocina se descongestione no significa que ya haya pollo—. Sin configurar, la capacidad queda **desactivada**: un límite inventado por defecto cerraría canales en negocios que nunca lo pidieron |
| **T5.19–T5.21** | **Bandeja omnicanal: entidades, ventana de 24 h y acciones del agente** | **Finalizada** | Migración `0027_conversations.sql`. **La conversación es de (tenant, marca, canal, contacto)** (RN-CNV-01): el mismo teléfono escribiendo a dos marcas del mismo tenant son DOS conversaciones. Va contra lo que hace un help desk normal —una por persona— por dos motivos concretos: quien escribe a la pollería no debe recibir el saludo del wok, y el coste de atención tiene que poder imputarse a una marca. **Ventana expirada: no deja escribir libre y fallar** (RN-CNV-03) — dejar pasar el texto y que Meta lo descarte en silencio es el peor de los dos mundos, así que el error **devuelve las plantillas disponibles**: uno que solo dice «no» acaba en un «te escribo por privado» que no queda registrado. **El traspaso bot→humano exige resumen**, con restricción en la BASE: sin él el humano abre con «hola, ¿en qué puedo ayudarte?» y el cliente lo cuenta todo otra vez, que es el momento exacto en el que la gente abandona. **Crear pedido desde la bandeja pasa por `OrderingService`** (RN-CNV-05): el total lo calcula el dominio y depende del canal —35 y no 37, porque `whatsapp` cae al precio base—, que es justo lo que demuestra que no fue un INSERT. **Las notas internas no salen salvo que se pidan** (RN-CNV-07), y una nota que se enviara al cliente es de los errores que no se deshacen |
| **T5.22–T5.30** | **Plataforma de IA: adaptador, RAG aislado, validador de salida, acciones deterministas, sandbox, traza y presupuesto** | **Finalizada** | Migración `0028_ai_platform.sql`. **Apagar la IA deja el sistema 100 % funcional** (ADR-0011): ninguna tabla de aquí es requisito de nada de fuera. El corazón es el **validador de salida** (RN-AIA-01) y la forma de comprobarlo importa, porque la obvia es la mala: pedirle al modelo en el prompt que no invente no es un control, es un deseo — lo cumple casi siempre, y «casi» aplicado a precios ES el problema. Se lee lo que el modelo quiere decir, se extrae todo lo que parece dato duro y **cada importe tiene que estar respaldado, en céntimos exactos**, por una herramienta llamada de verdad en esa conversación: comprobar solo el TIPO dejaría pasar el fallo más probable —consultar el precio del pollo y citar el de la gaseosa—. La prueba adversarial **levanta la aplicación entera** con un proveedor que responde «el pollo cuesta S/ 99.00» y comprueba que ese texto no llega al cliente; probar el validador aparte demostraría que la función funciona, no que está conectada. **Bloqueado deriva a un humano en vez de reformular**: pedirle otra redacción al mismo modelo que acaba de inventar un precio es pedirle que lo invente mejor. Configuración **versionada e inmutable** (RN-AIA-04): publicar crea una versión, no edita la vigente, y por eso el rollback es apuntar a otra fila. Presupuesto agotado **degrada a reglas, no a error** (T5.30): un agente que se cae cuando se acaba el saldo es peor que no tener agente, porque el cliente ya está esperando |
| **T5.31** | **Prompts versionados + suite de conversaciones doradas en CI** | **Finalizada** | Paquete propio `@sahana/ai-prompts` y no un archivo dentro del servicio: con los prompts dentro, cambiar uno y cambiar la prueba que lo cubre serían el mismo commit, que es exactamente cómo una regresión se aprueba a sí misma. **24 diálogos, 3 rubros, 29 turnos**, corridos contra el agente REAL —no contra el comparador— con el proveedor determinista. Es una suite de **contrato, no de estilo**: qué escalón resuelve cada turno, qué herramientas se llamaron, qué acciones se dispararon y qué no puede aparecer nunca; un cambio de redacción la pasa, uno que hace que una regla empiece a costar tokens, no. Corre como **paso propio y bloqueante** en CI y falla con el motivo de negocio de cada turno, no con un diff de texto. Migración `0029`: la traza guarda **la versión del prompt y los tokens** |
| **T5.32** | **Analítica del agente y KPI mensajes/pedido MEDIDO** | **Finalizada** | Migración `0030_conversation_orders.sql`. Contesta la única pregunta que decide si el agente se queda encendido: **¿vende, y a qué coste?** Conversaciones solo-IA frente a derivadas, conversión por origen (IA / humano / mixto), resoluciones por escalón —lo que costó tokens frente a lo que resolvió una regla gratis—, reglas más disparadas **del rango** (leer el `hit_count` acumulado haría ganar siempre a la regla más vieja) y **temas preguntados sin fuente**, con ejemplos literales: es la única métrica del panel que le dice al dueño QUÉ HACER. El coste va **en créditos y no en soles** porque no hay tarifa configurada, y ponerle una aquí sería inventar el dato que el dueño leería como su factura (PA-06). Sin pedidos, el coste por pedido es **NULL y no cero**: un cero se lee como «gratis» y lo que pasó fue gastar sin vender |
| **T5.33** | **E2E de compra digital: intención → webhook → aceptado → boleta → tracking** | **Finalizada** | Recorre el camino del COMPRADOR sin un solo atajo interno: carta desde el dominio de la marca, carrito de servidor, checkout, webhook firmado, aceptación por el barrido real, boleta contra el sandbox del OSE y tracking público. **Tarda ~0,3 s** frente al criterio de 2 minutos. Destapó que **la tienda no podía cobrar**: el checkout creaba el pedido y lo dejaba sin forma de pagarlo, porque crear una intención exige `payments.charge`, un permiso de personal que un comprador invitado no tiene ni debe tener. Ahora el checkout admite `payment: 'online'` y devuelve la referencia **opaca** y la URL; el proveedor lo elige el NEGOCIO y no el comprador, porque dejar que el cliente mande el nombre de la pasarela es la forma de apuntar el cobro a una conexión ajena. Por defecto sigue siendo contra entrega: con el pago en línea por defecto, una tienda sin pasarela habría roto el checkout de todos sus compradores el día del despliegue |
| **T5.34** | **E2E de la demo de IA en una pantalla** | **Finalizada** | Una sola conversación con los cuatro pasos que se le enseñan a un dueño: **promo por regla** (coste cero, verificado en la traza), **precio con datos vivos** (con `catalog.search` detrás), **carrito** —intención de compra → enlace real a la tienda, que la prueba abre y comprueba vacío— y **derivación con contexto**, con el resumen escrito y el hilo entero legible para quien recibe el traspaso. Todo por el camino real (mensaje → outbox → consumidor → agente) y leyendo del HILO, que es lo que el dueño ve. Añadió `order.start_cart` de la spec 19 §3: la **única escritura** del agente, y deliberadamente pobre — carrito vacío y enlace, porque lo que se compra se decide en el checkout estructurado |
| **T5.35** | **Canario y despliegue progresivo** | **Finalizada la parte de código; el reparto de tráfico es DT-02** | El criterio —**un despliegue malo se revierte sin tocar la base**— no lo garantiza la herramienta de despliegue sino las migraciones, así que se convirtió en dos gates. `infra/scripts/check-migrations.mjs` rechaza `DROP COLUMN`, `DROP TABLE`, renombrados, cambios de tipo y `NOT NULL` sin `DEFAULT`; las contracciones se declaran (`-- fase: contract` + `-- expande: <migración>`), que obliga a escribir contra qué versión se contrae. Y `GET /health/ready` **da por listo un esquema por delante del código**, que es el estado exacto tras revertir: si lo marcara como no listo, revertir exigiría tocar la base. Las dos piezas son la misma garantía y por separado ninguna vale. El balanceador y el 10 % de tráfico son infraestructura cloud |
| **T5.36** | **Pentest externo** | **Entregable humano — bloqueado por DT-02** | Alcance ya acotado en `docs/33-gate-fase-5.md` §5.1: los cinco escapes de RLS, el webhook de pagos, `pub_tokens`, el aislamiento por `Host` y la inyección de prompt contra las herramientas del agente |
| **T5.37** | **Gate F5** | **Finalizada** | `docs/33-gate-fase-5.md`. **APTO CON EXCEPCIONES**: 1 135 pruebas en verde, 5 de los 8 criterios de salida verificados automáticamente, y las cuatro excepciones —pentest, pilotos, canario completo y Lighthouse— con **la misma causa: DT-02**. Devolvió a verde el gate de SCA, que estaba en rojo con **3 hallazgos altos** transitivos de Next (`sharp`, `postcss`) |

**Lo que decide el orden.** Tres cadenas que no se pueden adelantar: **pagos antes que tienda** (un storefront sin pasarela es una demo, y dentro de pagos el webhook manda sobre el redirect — construir el redirect primero invita a confirmar pedidos con él «mientras tanto», y eso ya no se quita); **bandeja antes que agente IA** (el agente escribe EN una conversación: al revés necesitaría su propio almacén de mensajes y luego habría que fusionarlos con el histórico ya escrito); **plataforma `ai` antes que agente** (es lo que permite apagar la IA sin que se caiga nada). Y una regla que no es de dependencia sino de riesgo: el **validador anti-precio-inventado se construye ANTES** que la composición libre de respuestas, porque al revés se acaba probando contra los mismos casos que ya pasaban.

**Dos entregables humanos ya identificados:** el **pentest externo** (T5.36) y el **gate de negocio** de la fase — 3 operadores piloto usando F4 en producción real ANTES de cerrar F5. Este segundo probablemente marque el calendario, y exige que **DT-02 (entorno cloud) esté resuelto mucho antes del final**.

**Un cuarto escape acotado de RLS, y dónde se puso la línea (ADR-0016).** El webhook de pasarela tiene el mismo problema que el de marketplace —hay que saber de quién es el aviso ANTES de poder verificar su firma— pero con dinero detrás. La alternativa evidente era dejar la ruta como la escribe la spec 10 y resolver el tenant leyendo la referencia del payload; eso habría exigido un escape de lectura sobre `pay_intents`, que es una tabla **con importes**, y habría vaciado de contenido la frase sobre la que se sostiene ADR-0014 («ninguna tabla de negocio menciona el flag»). Se añadió en su lugar un token por conexión a la URL, de modo que el escape recae sobre `pay_connections`, que guarda credenciales. **Divergencia de la spec 10 registrada en la propia spec.**

**Lo que NO existe en el módulo de pagos, a propósito:** ningún endpoint que confirme un pago. No está desaconsejado — no está. Un `POST /payments/:id/confirm` con permiso de cajero parecería razonable y sería exactamente la vulnerabilidad que RN-PAY-01 previene. Hay una prueba que comprueba que devuelve 404.

**Un detalle de configuración que habría fallado en silencio:** el parser de cuerpo crudo solo cubría el prefijo de marketplace. Sin ampliarlo, la firma se habría calculado sobre bytes reserializados y **el 100 % de los avisos habría dado «firma inválida»**, mandando a depurar el secreto equivocado. Ahora es una lista con comentario que explica por qué toda ruta con HMAC tiene que estar en ella.

**Una consecuencia de ADR-0016 que apareció al implementar el barrido:** `pay_intents` no tiene escape de sistema —es tabla con importes— así que el barrido de devoluciones **no puede** hacer una consulta global. Enumera tenants bajo `app.system` (el catálogo de tenants sí es infraestructura de plataforma) y entra en el contexto de cada uno, igual que el barrido de aceptación. Es más lento que una consulta global; es también la única forma de que este barrido no sea un agujero por el que se vean los cobros de todos.

**El quinto escape de RLS, y por qué es el último de su especie (ADR-0017).** ADR-0016 cerró avisando: «si apareciera un quinto, la conversación ya no es *añadimos otro* sino *hace falta un mecanismo de primera clase*». Aparecieron dos a la vez —links de pago y tracking público de T5.16— y se ven venir más (recuperación de carrito, encuestas, confirmación de correo). Todos tienen la misma forma: una URL que llega a alguien **sin cuenta** y que tiene que resolver un tenant. La salida fácil —una columna `algo_token` por tabla y una política por caso— termina mal de forma concreta: cada escape es una tabla de negocio más legible sin contexto de tenant, y la frase que sostiene ADR-0014 se vuelve falsa **por acumulación**, sin que ninguna decisión individual parezca mala. Se construyó `pub_tokens`: una tabla, un escape, propósito cerrado, caducidad obligatoria y revocable. **T5.16 ya no necesita decisión propia.**

**Se rechazó el JWT firmado sin tabla**, que era la opción con cero consultas, por una razón práctica: **no se puede revocar**. Un link de pago que se manda al cliente equivocado, o un tracking que acaba en redes sociales, tiene que poder cortarse hoy y no cuando caduque.

**El bloque de pagos queda cerrado** (T5.01–T5.07). Lo que había en la base antes de T5.07 merece señalarse porque es un patrón que se repite: dos columnas bien diseñadas —`commission_estimated` y `commission_settled`— con sus comentarios explicando RN-BIL-04, sus tipos correctos y su sitio en la proyección… **y nadie que las escribiera**. Es la misma forma del fallo que destapó la carga en T4.30 (`processPending` sin llamar) y del de la ingesta en T4.32: la pieza existe, está bien hecha, y no está conectada. El esquema no miente sobre lo que se puede guardar; miente sobre lo que se está guardando.

**La tienda no resuelve precios: los pide.** El primer intento de T5.08–T5.13 tenía su propio SQL para saber si un producto se puede vender y a cuánto —precio del canal `web`, pausa vigente, filtro por marca—, una copia razonable de lo que ya hace `CatalogService`. Funcionaba, y ese es el problema: **el día que cambie una regla de precios, la tienda cobraría distinto que la caja**, y nadie se enteraría hasta que un cliente reclamase. Se sustituyó por el catálogo resuelto del módulo Catalog, que a su vez resuelve con `@sahana/domain`. Un solo sitio decide, como exige la regla de «cálculo SOLO en `@sahana/domain`».

**Los modificadores se validan al AGREGAR, no al pagar.** Al enchufar la tienda contra el pedido apareció el fallo de verdad: un producto con grupo obligatorio —el tamaño del pollo— entraba en el carrito sin elegir nada, y el rechazo llegaba **en el checkout, con la tarjeta ya en la mano**. Ahora se valida en `addLine` con la MISMA función que usa el pedido (`validateAndPriceModifiers`), así que la tienda y la caja no pueden discrepar. En el mismo sitio se cerró que una opción de otro producto no cuele: ignorarla dejaba salir con un precio que no existe.

**El recojo necesitaba un local y no lo tenía.** «Sin cobertura → recojo» se quedaba a medias: sin zona no hay local resuelto, y el pedido llegaba a `submit` sin local, que lo rechaza con `ORDER_BRAND_NOT_SERVED`. Justo la venta que el modo recojo venía a salvar. Ahora el local de recojo es **la cocina que produce la marca**.

**El harness de aislamiento no servía para la tienda, y se arregló el harness.** Su comprobación de simetría compara la respuesta con el token de A y con el de B; en la tienda el token **ni se mira** —el tenant sale del `Host`—, así que las dos respuestas son idénticas por construcción y el harness lo denunciaba como fuga. La salida fácil era saltarse el paso para endpoints públicos, y habría dejado sin comprobar precisamente la superficie que más lo necesita: la única que atiende sin sesión. Se añadió `requestAsB` (la petición equivalente del otro tenant, con su host) y se **exige declararla**: un endpoint público sin ella falla con un mensaje que explica qué falta. `tenantless` queda para lo que de verdad no es de nadie, como `/health` —que hasta ahora pasaba por casualidad, porque su `traceId` cambia en cada petición.

**Tres fallos que solo se ven ejecutando la tienda en un navegador, y una deuda nueva (DT-08).** Al montar `apps/web` aparecieron tres, y los tres pasaron typecheck, lint y las 484 pruebas de la API: (1) **`fetch` de Node descarta en silencio la cabecera `host`** —es una cabecera prohibida—, así que la tienda pedía el catálogo sin decir de quién era y la página respondía **200 con «no hay ninguna tienda en este dominio»**; (2) los precios se pintaban **`S/ NaN`** porque el JSON de `Money` no trae el campo que se supuso; (3) un archivo `'use server'` **no puede exportar una constante**, y el texto del consentimiento tumbaba el catálogo con un 500. Lo que comparten es la forma: **la página carga bien**. Ninguna prueba de las que existen mira una página. Queda anotado como **DT-08 con fecha límite en el gate de F5**; adoptar un runner de navegador necesita ADR, y la recomendación es Playwright.

**La zona de reparto: filtro, no preferencia.** La primera versión de RN-DLV-01 puntuaba a todos los repartidores y bonificaba a quien cubría la zona. La prueba y la implementación se contradecían —las escribí ambas— y hubo que elegir de verdad: **filtro**. Si un repartidor declara zonas es por un motivo real —conoce el distrito, tiene el permiso, vive allí— y ningún score debe mandarle fuera de ellas solo porque vaya menos cargado; la regla de la spec además nombra la zona primero. Con el filtro, la bonificación quedaba como peso muerto y se borró. Si **nadie** cubre la zona se devuelven todos, avisando: un pedido sin repartidor posible es un pedido que no sale, y es preferible que el encargado mande a alguien de fuera sabiéndolo.

**`RequirePermission` aceptaba `string`, y eso ya había colado dos permisos que no existen.** `catalog.manage` (entregado en T5.08–T5.13) y `delivery.manage` compilaban, pasaban las pruebas y dejaban sus endpoints accesibles **solo para quien tiene el comodín**. Fallan cerrado, que es lo que hace el fallo tan silencioso: nadie se entera hasta que un supervisor dice «no me deja» y el permiso que le falta no está en ninguna parte. El decorador está ahora tipado contra el catálogo, y el catálogo se movió a `common/permissions.ts` — que es lo que hace posible tiparlo sin el ciclo `common → identity → common` que `dependency-cruiser` rechaza, con razón, incluso para importaciones de tipo. De paso, el rol **repartidor** gana `delivery.operate`: existía sin poder marcar una sola entrega, y alguien habría acabado dándole permisos de supervisor «mientras tanto».

**Dónde vive la pausa de canal, y por qué no en Kitchen.** Quien tiene que consultarla es **Ordering**, al aceptar un pedido, y Ordering no puede depender de Kitchen: Kitchen ya depende de Ordering —consume `order.accepted`— y la flecha inversa cerraría el ciclo. La tabla es `ord_channel_pauses` y Kitchen la escribe llamando a la API pública de Ordering. La alternativa evaluada, pausar producto a producto en `cat_product_pauses`, habría metido miles de filas por cada pico y un despausado que hay que acertar entero; pausar el CANAL es una fila. Y `0026` va aparte de `0025` porque esta ya estaba aplicada: **editar una migración corrida deja los entornos divergentes en silencio**, y una migración aplicada es historia, no un borrador.

**La bandeja va antes que el agente, y ese orden es la decisión.** El agente de IA escribe EN una conversación. Construirlo primero le habría obligado a tener su propio almacén de mensajes, y luego habría hecho falta fusionarlo con el histórico ya escrito — una migración de datos con conversaciones de clientes reales dentro. Con la bandeja en pie, T5.22+ solo añade un autor más (`bot`) a una tabla que ya distingue bot, agente concreto y sistema: la pregunta «¿esto lo dijo la IA o una persona?» tiene respuesta desde hoy, y con un booleano no la tendría.

**El prompt vivía en el servicio y no dejaba rastro.** `buildSystemPrompt` y `SYSTEM_PROMPT_VERSION` estaban escritos, comentados y **sin usar**: el agente seguía construyendo su prompt con una función local. Es la misma forma del fallo que ya destaparon T4.30 (`processPending` sin llamar) y T5.07 (las columnas de comisión que nadie escribía) — la pieza existe, está bien hecha, y no está conectada. Ahora el agente usa el prompt versionado y la traza guarda **con qué versión** respondió; sin ese dato, «desde el martes responde peor» no se puede atribuir a nada, porque el prompt es texto que vive en el código y cambia sin dejar huella en los datos. Una resolución por regla **no lleva versión**: atribuirle una sería contar como «respuesta de v1» algo que v1 no escribió. En la misma pasada se conectaron `input_tokens` y `output_tokens`, que llevaban desde `0028` esperando a alguien: se contaban para cobrar créditos y **no se guardaban**, así que «cuánto cuesta una conversación» solo se podía estimar — y una estimación no sirve para facturar (T5.32 depende de esto).

**Dos fallos de producción que solo aparecieron al correr la suite dorada, y los dos son el mismo bug.** (1) `/\bmen[uú]\b/` **nunca casa con «menú»**: las vocales acentuadas no son caracteres de palabra en JavaScript, así que entre «ú» y el signo de cierre no hay frontera. «¿Me pasas el menú?» y «¿hacen envío?» no disparaban ninguna herramienta y la respuesta salía sin catálogo ni cobertura detrás — justo lo que el validador acaba bloqueando y el cliente vive como un bot que no contesta. Los límites de palabra pasan a ser lookarounds sobre `\p{L}\p{N}`, que sí tratan la tilde como letra y de paso hacen que el plural dispare sin dejar entrar «cartera» por «carta». (2) La detección de reclamo solo cubría **«frío» masculino singular**: «la pizza llegó fría» —el reclamo literal de una pizzería— pasaba como conversación normal y nadie la atendía. Ahora hay concordancia de género y número, y «llegó» a secas **sigue sin derivar**: «¿ya llegó mi pedido?» es una consulta de estado, y gastar a una persona en ella es justo lo que el agente existe para evitar. Es la tercera vez en esta fase que la tilde rompe algo; el patrón ya está anotado en los comentarios de las dos funciones.

**El gate de formato llevaba varios commits en rojo.** `pnpm format:check` fallaba con 41 archivos en `HEAD` — arrastrado desde T5.15 en adelante. Un gate que nunca pasa deja de leerse, y el siguiente que se rompa de verdad no lo verá nadie. Saldado: 45 archivos formateados y el gate en verde.

**Una anomalía observada una vez y no reproducida:** en una corrida de la suite completa fallaron 24 pruebas de un archivo con `supertest`; tres corridas completas posteriores dan **545/545**. No se identificó el archivo y no hay hipótesis con evidencia, así que queda anotado aquí en vez de darse por resuelto: si reaparece, lo primero que hay que capturar es el nombre del archivo.

**EL AGENTE NO ERA ALCANZABLE.** Es el hallazgo de T5.32 y el peor de la familia. `conversation.message_received` se publicaba en cada mensaje entrante desde T5.19 y **no lo escuchaba nadie**: la única ruta que llamaba a `AgentService.respond` era el **sandbox**, la pantalla de pruebas del dueño. Toda la plataforma de T5.22–T5.31 —jerarquía de ADR-0011, herramientas tipadas, RAG por tenant, validador anti-precio-inventado, presupuesto, suite dorada— estaba construida, probada y **no contestaba a ningún cliente**. Un mensaje por WhatsApp entraba, se guardaba y ahí se quedaba. Los antecedentes eran de la misma forma pero más pequeños (`processPending` sin llamar en T4.30, las columnas de comisión sin escritor en T5.07, el prompt versionado sin usar en T5.31); aquí no faltaba una llamada dentro de un flujo: **faltaba el flujo entero**. Ninguna prueba lo detectó porque todas llamaban a `respond` a mano — incluida la primera versión de la suite dorada, que medía un camino que ningún cliente recorre.

Se cerró con `AiEventHandlers`, consumidor propio en `inbox`, registrado el ÚLTIMO en el worker: si contestar falla, el ticket de cocina y la analítica ya están escritos en sus transacciones; al revés, un fallo del modelo retrasaría la comida. Va por evento y no por llamada desde `receiveInbound` porque Conversations no puede depender de AI —la flecha ya va al revés— y porque así **apagar la IA es no arrancar el consumidor**, que es lo que ADR-0011 exige. La respuesta del bot ahora **queda en el hilo como mensaje del bot** (RN-CNV-04): antes, quien recibía un traspaso no veía nada de lo que el bot había dicho. Con idempotencia propia: la reentrega de un evento no puede contestar dos veces, porque dos respuestas idénticas seguidas se ven, en WhatsApp, exactamente como un bot roto.

**La prueba de cableado se generalizó.** La que existía desde T4.30 solo miraba los `PeriodicJob`. Un módulo puede traer trabajo de fondo de dos formas —barrido o consumidor— y solo una estaba vigilada. Ahora recorre las APIs públicas de los módulos y **exige que todo `*_CONSUMER` exportado esté registrado en el worker**; se verificó que falla de verdad desconectando el de IA a propósito.

**Una regla de ESLint que acertó por el motivo equivocado.** `conversations.total: number` disparó la regla anti-`number` monetario, que va por nombre. No había dinero —son conversaciones— y la salida fácil era silenciarla; se renombró a `count`. La excepción de hoy es la que mañana deja pasar un importe.

**El validador bloqueó una respuesta legítima, y tenía razón.** Al añadir el carrito, la herramienta devolvía «Carrito **abierto** para este cliente: <enlace>». El validador de T5.24 leyó «abierto» como una afirmación de horario, no encontró ninguna herramienta que la respaldara —`order.start_cart` declara `kinds: []` a propósito— y bloqueó la respuesta entera: el cliente no recibía nada. El fallo no era del validador sino de la redacción. Queda como regla escrita en el propio servicio: **todo lo que una herramienta mete en el contexto puede acabar citado por el modelo, así que una herramienta que no respalda hechos no puede escribir palabras que parezcan uno.**

**Dos preguntas abiertas nuevas, ninguna inventada.** **PA-06**: a cuántos soles equivale un crédito de IA — la analítica publica el coste en créditos porque no hay tarifa en ninguna parte, y ponerle una en el código sería inventar el dato que el dueño leería como su factura. **PA-07**: la tienda no captura DNI/RUC, así que la boleta de una venta web la tiene que emitir una persona; decidir si el checkout invitado lo pide.

**El gate de SCA estaba en rojo y nadie lo había mirado.** Al preparar el gate de fase aparecieron **3 hallazgos altos**, los tres transitivos de Next.js: cuatro CVE de `libvips` heredados por `sharp`, y dos de `postcss` —lectura arbitraria de ficheros y *path traversal* vía `sourceMappingURL` en comentarios CSS—. Saldados con `overrides`, comprobando después que la tienda sigue compilando y **dentro de presupuesto** (106 KB de 200). Es el mismo patrón que el gate de formato de la semana pasada: un gate que lleva días en rojo deja de leerse, y entonces deja de proteger.

**Fase 5 cerrada con excepciones, y las cuatro tienen la misma causa.** Pentest, pilotos, canario completo y Lighthouse dependen todas de **DT-02: no hay entorno cloud**. Esa deuda ya no bloquea una tarea — bloquea el cierre de la fase. **DT-08** (sin pruebas de navegador para la tienda) venció en este gate sin saldarse: adoptar un runner necesita ADR, y la recomendación sigue siendo Playwright.

## Fase 6 — Backlog propuesto

**T6.00 finalizada:** `specs/phases/phase-6-inventario-costos.md` trae ya su backlog de 17 tareas derivado de la spec 08 (parte F6), la 16, la 09 y docs/15. **Pendiente de aprobación del propietario**, como lo estuvo el de F5.

El corazón de la fase son **T6.03 (costo promedio móvil)** y **T6.11 (cierre mensual reproducible)**. La decisión que hay que acertar en la primera tarea y no se puede recuperar después: **cada movimiento guarda el costo VIGENTE en su momento**. Sin ese snapshot, recalcular el histórico con el costo de hoy reescribe la rentabilidad de meses ya cerrados, y no hay forma de reconstruirlo.

**No se ha implementado nada de F6, y no debe implementarse todavía.** El criterio común 7 exige aprobación explícita del propietario para pasar de fase, y el gate de negocio de F5 —tres operadores piloto en producción real— sigue bloqueado por DT-02. Además hay una precondición práctica: el inventario real solo se prueba contra consumo real; hasta que alguien venda de verdad, cualquier conciliación se valida contra datos sintéticos, que siempre cuadran.

**DT-08 saldada: la tienda ya se prueba en un navegador (ADR-0018).** Playwright, acotado a `apps/web`, **un solo motor**, contra el build real y bloqueante en CI. Seis pruebas en **3,4 s**. Cada una corresponde a un fallo que OCURRIÓ —el `host` descartado por undici, el `S/ NaN`, el `'use server'` con una constante— y se comprueba **por su síntoma**, que es lo que el cliente ve, no por su causa técnica, que la próxima vez será otra. Cubre además la promesa de T5.14 de que la tienda **funciona sin JavaScript**, que hasta ahora era una frase en un documento.

**Y escribirlas destapó el cuarto de la misma familia.** El checkout decía «**Cambiar** dirección» a quien no había escrito ninguna: el estado se deducía de «tiene líneas y no es recojo» en vez de leer el bloqueador `NO_ADDRESS` que el servidor ya mandaba en la respuesta. Una palabra equivocada, en el paso exacto donde el comprador decide si sigue o cierra la pestaña.

**Dos cosas que la propia suite enseñó sobre sí misma**, ambas anotadas en el código para que no se repitan: la sonda de arranque de Playwright tiene que ir por **IP** —el navegador resuelve `*.localhost` por especificación, Node no—, y con JavaScript activo hay que **esperar la respuesta de la acción de servidor**, porque `click()` vuelve en cuanto despacha el evento y navegar a continuación adelanta al servidor. Sin JS no pasa, y esa asimetría es justo la clase de intermitencia que ADR-0018 prohíbe tapar con un `waitForTimeout`.

**dependency-cruiser: cero violaciones y cero advertencias, por primera vez.** Las que quedaban eran huérfanos por definición —rutas de Next, que descubre el framework, y configuraciones— y una lista de avisos que nunca baja a cero enseña a ignorarla entera.

## Puesta en marcha — el sistema ya se puede levantar

**No había Dockerfiles.** Toda la fase 5 se cerró sin que existiera una imagen que desplegar: el sistema se ejecutaba con `pnpm dev` y nada más. Ahora hay `infra/docker/Dockerfile.api` (API **y worker**: una imagen, dos comandos, para que no puedan divergir en el cálculo de totales), `Dockerfile.web` con salida autónoma de Next, y `docker-compose.prod.yml` para una máquina. Todo **verificado de verdad**: imágenes construidas, stack arrancado, 30 migraciones aplicadas por el servicio `migrate`, `/health/ready` en verde y sesión iniciada.

**Y faltaba lo más básico: no se podía crear el primer cliente.** `provisionTenant` estaba escrito y probado desde T3.07, sin endpoint —correcto: sin autenticar sería una puerta abierta, y autenticado no serviría porque en un despliegue nuevo no existe ningún usuario— y sin CLI en la imagen, porque los guiones de semilla son TypeScript que la imagen de producción no lleva. Un servidor recién levantado arrancaba sano y **vacío para siempre**. Ahora `node dist/database/provision.js` da de alta un cliente; se probó contra el stack desplegado y la dueña entra al panel.

**Tres defectos que solo aparecen al construir y arrancar de verdad:**

· **Un `.tsbuildinfo` en el contexto de construcción.** TypeScript leía estado de compilación de OTRA máquina, decidía que ya estaba todo hecho y **no emitía nada**. La imagen terminaba en verde, sin `dist`, y el fallo salía dos capas después como «no encuentro `@sahana/domain`». Ya está en `.dockerignore`, con el porqué escrito.

· **Una variable opcional VACÍA impedía arrancar.** En un `.env` se declara «no lo uso» dejándolo en blanco, y `docker compose` propaga la cadena vacía; zod, con razón, no acepta `''` como URL. Resultado: quien no usa OpenTelemetry **no podía levantar la API**, con un «Invalid url» sobre algo ni siquiera obligatorio. Ahora vacío equivale a no puesto, con pruebas del borde.

· **Las contraseñas de los roles de base de datos estaban escritas en el repositorio.** `01-roles.sql` creaba `sahana_app` —el rol que lee los pedidos de todos los clientes— con una contraseña pública. Ahora es un script que las toma del entorno, y el compose de producción las **exige**: sin ellas no levanta.

**Las imágenes se construyen en CI.** Un Dockerfile roto no se descubre desplegando un viernes; los dos fallos de construcción de arriba son exactamente lo que ese job caza y `pnpm build` no puede ver.

**Lo que este despliegue NO trae, dicho por adelantado** (`docs/34-puesta-en-marcha.md` §9): alta disponibilidad, copias gestionadas —hay comando, pero **hacerlas es de quien levanta**—, escalado del Postgres local, canario con reparto de tráfico y certificados. Todo eso sigue siendo **DT-02**.

## Hallazgo grave: falta la mitad de administración del producto

Al escribir el runbook de puesta en marcha afirmé que, tras dar de alta al cliente, «todo lo demás se hace desde el panel». **Al verificarlo, el panel no existe.** Y tirando del hilo apareció algo mayor.

**DT-09 — no hay ninguna interfaz de administración.** `apps/web` solo contiene la tienda del comprador; `apps/pos` no existe. Las tres —panel, POS y KDS— están **especificadas y asignadas a estas fases** (`specs/ux/03-panel.md` dice literalmente «Fase 4–5»; `01-pos.md` y `02-kds.md`, F4), y **ningún backlog de F4 ni de F5 las incluyó**. Los gates de las dos fases no lo detectaron porque comprueban pruebas, cobertura y criterios de salida, no superficie de spec.

**DT-10 — no hay forma de crear los datos de negocio.** Ni marca, ni local, ni zona, ni horario, ni categoría, ni producto. La spec 03 pide «CRUD empresas/marcas/locales/cocinas/estaciones/almacenes/zonas/horarios» y la spec 04 «CRUD completo»; de las dos solo se construyó la mitad de **lectura** —`getResolvedCatalog`, `findCoverage`, `getStructure`, pausar y reanudar—. Las únicas escrituras que existen son las semillas demo, con SQL directo y siempre la misma pollería ficticia. **T3.12b, T4.01 y T4.03 se dieron por finalizadas sobre esa mitad.**

Dicho sin rodeos: el motor está completo y muy probado —1 141 pruebas, RLS, outbox, pagos, facturación, delivery, agente— y **un cliente nuevo no puede cargar su carta por ningún medio**. Un piloto podría vender por tienda web y por WhatsApp solo si alguien le monta el negocio con SQL a mano, y no tendría pantalla de mostrador ni de cocina.

**Por qué no se vio antes.** Cada tarea se cerró contra su criterio del backlog, y los criterios estaban bien escritos; lo que faltaba era **la tarea**. Es el mismo patrón que el resto de la fase —la pieza que existe y nadie conecta— pero un nivel más arriba: aquí no falta el cable, falta el aparato. Y el gate de fase no lo pilla porque pregunta «¿cumple lo que el backlog prometió?» y no «¿está lo que la spec pide?».

**Corregido en `docs/34-puesta-en-marcha.md`:** el runbook ya no promete un panel que no existe, y §10 lista la ausencia de panel, POS y KDS entre lo que este despliegue no trae.

### DT-10, primera mitad: ya se puede crear un negocio por API

Empresa, marca, local, cocina, unión marca↔cocina, estación, zona y horario. Con permiso propio `org.write` —que **no lleva el supervisor**: quien crea una zona decide a qué direcciones se reparte y con qué tarifa, y quien crea un local decide dónde se produce—, auditoría en cada escritura y las pruebas de aislamiento obligatorias.

Tres decisiones que cambian cómo se opera esto:

· **Todo es idempotente por clave natural** —RUC de la empresa, `slug` de la marca, nombre del local dentro de la empresa—. No es comodidad: una configuración se aplica varias veces y una segunda pasada que duplica la marca deja un negocio con dos cartas y ningún modo de saber cuál cobra. Hay prueba de que reaplicar no duplica.

· **El rectángulo envolvente lo calcula el servidor, siempre**, con la misma función del dominio que usa la consulta de cobertura, y no se acepta del cliente ni aunque lo mande. Un `bbox` que no encierra al polígono hace que la cobertura mienta —direcciones dentro de la zona que se rechazan— y el error es invisible hasta que alguien reclama.

· **El RUC se valida al crear la empresa, no al facturar.** Uno mal escrito que solo se compruebe en el comprobante se descubre el día que el OSE rechaza la primera boleta, con el cliente delante.

La prueba que decide si esto sirve no es que las filas se escriban, sino que **lo creado sea lo que el resto del sistema consulta**: la suite monta un negocio entero por API y luego pregunta por `findCoverage` y `kitchensForBrand`. Una tabla paralela que parece bien no habría pasado.

### DT-10, segunda mitad: la carta — **DT-10 saldada**

Categorías, productos, precios por ámbito, grupos y opciones de modificadores, unión producto↔grupo y componentes de combo. Con `catalog.write`, auditoría y las pruebas de aislamiento obligatorias, incluida la que más importa aquí: **el tenant B no puede ponerle precio a un producto de A**.

Tres cosas que no eran obvias al empezar:

· **La clave natural del producto es el SKU, y el nombre solo si no hay SKU.** Es lo que permite renombrar sin duplicar: «Pollo a la brasa» pasa a «Pollo a la brasa entero» y sigue siendo el mismo producto, con su historial de ventas. Sin SKU, cada renombrado crearía uno nuevo y el anterior se quedaría en la carta.

· **La marca del precio se deriva del producto, nunca del cuerpo.** Si se aceptara, un precio podría acabar apuntando a otra marca y desaparecer de los dos catálogos a la vez, sin que nada fallara.

· **Las claves foráneas del esquema son por `(tenant_id, id)`: impiden cruzar tenants pero NO cruzar marcas.** Nada en la base evitaba ponerle a un producto de la marca B una categoría de la marca A, o un grupo de modificadores de otra marca — y el síntoma habría sido silencioso: la categoría no aparece, el modificador sí, y el cliente elige una bebida que esa cocina no tiene. Se comprueba en el servicio, que es donde se puede dar un mensaje que se entienda.

`If-Match` sobre `row_version` es **opcional** aquí, al revés que en un pedido: subir la carta entera de golpe es el caso normal y exigir la versión de cada plato lo haría imposible; cuando viene, un desfase devuelve 409 y no pisa el cambio del otro.

Y la comprobación que decide si esto sirve, otra vez: no que las filas se escriban, sino que **el precio que el dueño escribe sea el que la tienda muestra y el que el pedido cobra**. La suite crea la carta por API, la lee con `getResolvedCatalog` y manda un pedido: 59.00 del canal web más 3.00 de la ensalada, 62.00. Con el precio base habrían sido 58.00, y la carta por canal sería decorativa.

### Y un negocio entero desde un archivo

El runbook prometía `setup-business.js` y `infra/ejemplos/negocio.ejemplo.json`. **Ninguno de los dos existía.** Ahora existen los dos: el archivo describe empresa, marcas, dominio de tienda, locales, cocinas, estaciones, zonas, horarios y la carta completa, y el comando lo aplica de una vez sobre un tenant ya creado.

Los importes van **como cadena en soles** —`"12.50"`— y se convierten a unidades menores con aritmética entera. Pasar por `Number` sería meter coma flotante en la única cifra que no la admite.

La lógica vive en `business-setup.ts`, separada del envoltorio de línea de comandos **para que una prueba pueda ejecutarla contra el ejemplo del repositorio**. Y la ejecuta: monta el negocio, resuelve la tienda por su host, comprueba la cobertura y su tarifa, manda un pedido y verifica el total; luego reaplica el mismo archivo con un precio cambiado y comprueba que corrige sin duplicar. Un ejemplo que nadie ha ejecutado se descubre roto con el cliente delante — que es exactamente lo que le pasó a la versión anterior de este runbook.

### El panel existe — DT-09 se reduce al POS y al KDS

`/panel`, dentro de `apps/web`. Entrar, ver cómo va el día, editar la carta y sus precios, pausar y reactivar un plato, dar de alta marcas y locales. Ocho pruebas de navegador, porque lo que puede romperse en un panel **sin que la API se entere** —que la sesión no persista entre pantallas, que un enlace lleve a la tienda, que el precio guardado no sea el escrito— no se ve desde la API.

Cuatro decisiones que valen más que las pantallas:

· **La sesión son dos cookies `httpOnly`, nunca `localStorage`.** Un token legible por JavaScript es un token que cualquier script inyectado se lleva, y con él se leen la carta, los pedidos y la facturación de un cliente entero. Como todas las llamadas salen del servidor de Next, el navegador tampoco necesita verlo.

· **El panel puede NO servirse.** `apps/web` sirve la tienda de cada cliente en su propio dominio; sin la variable `SAHANA_PANEL_HOST`, `polleria.pe/panel` enseñaría la pantalla de acceso de la plataforma dentro de una tienda ajena. No hay fuga de datos —el tenant sale del token— pero un formulario de acceso donde nadie lo espera es donde se pescan contraseñas. Con la variable puesta, en los demás hosts responde 404.

· **El listado de la carta NO es el catálogo resuelto.** Aquel omite a propósito el producto sin precio y el pausado, porque un cliente no debe verlos; un panel construido sobre esa vista no podría enseñar el producto al que le falta el precio —el que hay que arreglar— ni el pausado —el que hay que reactivar—. Sería una pantalla que oculta exactamente el trabajo pendiente. Por eso hay un `GET /catalog/products` propio.

· **El refresco de sesión es una ruta, no parte del renderizado.** El token de acceso dura quince minutos y el panel se usa a ratos; sin refrescar, mirar las ventas, atender el mostrador y volver significaría escribir la contraseña otra vez. Pero un componente de servidor no puede escribir cookies mientras renderiza. Así que la página que se topa con un 401 redirige a `/panel/refrescar`, que renueva y devuelve — con un `intento` de ida y vuelta para que un token muerto no rebote para siempre entre dos redirecciones.

La tienda se movió a un grupo de rutas `(tienda)` para que no comparta marco con el panel: antes el `layout` raíz resolvía la marca por el host, y colgar el panel de él habría hecho que cada pantalla de gestión llamara a la API de tienda para pintar un rótulo que no le corresponde. Hay una prueba de navegador que comprueba que la tienda siguió siendo la tienda.

Y la comprobación que decide si el panel sirve, la misma de siempre: **lo que el dueño escribe es lo que el cliente ve**. La prueba cambia el precio del canal web a 61.50 desde el panel, recarga la tienda y comprueba que ahí pone S/ 61.50. Un panel que guardara en una tabla que la tienda no lee no es un panel, es un formulario bonito.

### El POS y el KDS existen — DT-09 saldada

`apps/pos`: una PWA con Vite (ADR-0019), IndexedDB, service worker propio y las dos superficies dentro. Catorce pruebas, y la que manda es la del backlog: **veinte ventas sin red, veinte en el servidor**.

Antes hubo que soldar la pieza que faltaba, y era la de siempre: **`authenticateDevice` estaba escrito, probado y sin ningún llamador desde HTTP**. Una tablet emparejada tenía un `deviceToken` y ninguna forma de usarlo. Cuarta vez que aparece este patrón en el proyecto.

La sesión del POS son dos factores porque responden dos preguntas distintas: **el dispositivo dice DÓNDE se vende y el PIN dice QUIÉN vende**. Solo con contraseña, el cajero acabaría escribiéndola en un papel pegado a la caja; solo con PIN, cuatro dígitos serían la única barrera desde cualquier navegador de internet. Y el dispositivo se comprueba primero: si el PIN fuera antes, cualquiera podría bloquear la cuenta del cajero a base de intentos y dejar al mostrador sin cobrar en hora punta. Hay prueba de las dos cosas.

Al comprobar que el token **sirve para algo** —no solo que se emite— apareció otro defecto: `GET /auth/me` exigía `tenant.read`, que un cajero no tiene. El POS entraba con su PIN y lo primero que hacía, preguntar quién es, le respondía 403.

Tres decisiones del POS que no son de interfaz:

· **Cobrar no llama al servidor.** Ni una vez. El total se calcula en el dispositivo con el mismo `@sahana/domain` que el servidor usa al recalcular —es la razón de que sea una PWA y no una app nativa (ADR-0006 §3.2)— y la venta se encola en el aparato.

· **Se vende siempre de la carta descargada, también con internet.** Si con red se vendiera de una respuesta fresca, el modo offline sería un camino distinto que solo se ejercita cuando algo falla, y esos caminos siempre están rotos.

· **Una venta encolada no se borra hasta que el servidor confirma.** Borrar al enviar y perder la respuesta haría desaparecer del dispositivo una venta que no está en el servidor: dinero cobrado y no registrado. Hay prueba.

**Lo que no se hizo, y por qué**: el KDS **no tiene «Deshacer»**, y la spec lo pide. Retroceder un ticket exige transiciones inversas en la máquina de estados de cocina y decidir qué pasa con un pedido que ya emitió `kitchen.order_ready`: es una regla de negocio, no un botón. Escribí uno que solo mostraba un aviso, releí mi propio comentario —«un botón que no deshace es peor que ningún botón»— y lo quité. Queda como **DT-11**. Tampoco están el cierre de caja por denominación, la impresión desde la tablet ni el modo TV; están listados en `apps/pos/README.md` y en el runbook.

### La caja cuadra: la venta del mostrador llega al arqueo

Al montar la pantalla de cierre apareció un defecto que llevaba ahí desde F4 y que ninguna prueba podía ver: **ninguna venta del POS entraba en `cash_movements`**. Esa tabla solo la escribían el endpoint manual y el cobro contra entrega, así que un turno con S/ 2 000 en efectivo cerraba con un «esperado» igual al fondo inicial y un sobrante exactamente del tamaño de lo vendido. Todos los días, en todos los locales.

Y había un segundo eslabón roto antes: **el POS mandaba el medio de pago y el servidor lo tiraba a la basura**. `offlineOrderSchema` no declaraba `paymentMethod` y zod lo quitaba en silencio. El dato con el que se decide si una venta mueve la gaveta no llegaba nunca.

Las dos piezas estaban bien por separado —la caja sabía sumar movimientos, el POS sabía cobrar, el pedido se guardaba correcto—; faltaba el cable. Es la quinta vez que este patrón aparece en el proyecto.

Arreglado con la migración 0031 (`ord_orders.payment_method`, columna nueva y anulable) y un **consumidor de caja** sobre el outbox. Por evento y no llamando a Cash desde Ordering, por dos motivos: Ordering no puede depender de Cash, y sobre todo **una caja cerrada no puede tumbar una venta** — si el cobro fallara porque alguien cerró el turno por descuido, el mostrador se quedaría sin poder cobrar. Por el outbox la venta entra siempre y el apunte se registra si hay dónde.

Cuatro pruebas nuevas, drenando el outbox por el camino real: la venta en efectivo sube el esperado, la de tarjeta se registra y **no** mueve la gaveta, sin turno abierto no revienta nada, y reprocesar el evento no suma dos veces.

Y la pantalla que faltaba: **cierre de caja contando por denominación**, con la diferencia en vivo mientras se cuenta —que es lo que hace que quien cuenta vuelva a contar en el momento, y no que el descuadre aparezca semanas después— y motivo más PIN de supervisor ante cualquier descuadre, aunque sea de diez céntimos. La caja **necesita red** a propósito: vender sin conexión sí; arquear sin conexión, no. Y si quedan ventas sin sincronizar, la pantalla lo dice antes de dejar cerrar.

### El POS imprime

Comanda a cocina y precuenta, contra el `print-agent` de la caja. El agente estaba completo desde F4 —cola propia, reintentos, ESC/POS, reimprimir— y **la tablet no le mandaba nada**. Otro cable.

Va contra el agente y no contra la API por lo mismo que la venta: la impresora está en el mostrador, colgada de la red del local y a menudo es una térmica USB sin IP. El servidor no la alcanza, y aunque la alcanzara, imprimir por internet dejaría a la cocina sin comandas justo cuando el POS sí puede seguir vendiendo. **Imprimir funciona sin internet.**

Tres decisiones:

· **Primero se encola la venta, después se imprime.** Imprimir puede fallar —agente apagado, papel, wifi— y una venta que no se registra porque la impresora no responde es dinero cobrado que no existe en ninguna parte.

· **La comanda no lleva precios.** La cocina no cobra, y un papel con importes en la zona de preparación es una fuente de confusión y de reclamos. Hay prueba de que no se cuela ni un «S/».

· **El id del trabajo se deriva dentro del módulo**, no lo pasa quien llama. La cola del agente deduplica por ese id: reintentar no imprime dos comandas, y derivarlo dentro impide el error contrario —usar el mismo para comanda y precuenta haría que la segunda se descartara en silencio—.

Y un defecto que encontró la prueba antes de que lo viera nadie: **la precuenta no cuadraba**. Con 116.00 y IGV incluido, la base sale 98.3050 y el impuesto 17.6950; truncando cada uno a dos decimales daba 98.30 + 17.69 = 115.99. Ahora se redondea a céntimos y **el impuesto se deriva de la resta de lo impreso**, así que base + IGV da siempre el total que se cobra. Una precuenta que no suma es lo primero que un cliente señala con el dedo.

**Lo que no cuadra todavía y queda escrito (DT-12):** el número del papel es un correlativo del dispositivo, porque se imprime antes de sincronizar y el definitivo lo pone el servidor. Va marcado como provisional en el propio ticket. Cuadrarlos exige reservar bloques de correlativos por dispositivo, que es una regla de negocio con implicaciones en facturación.

### El KDS deshace — DT-11 saldada

Un cocinero con las manos ocupadas toca la tarjeta con el codo. Ahora puede deshacerlo durante ocho segundos, y **deshace de verdad**: transición inversa `resume_preparing` (`ready → preparing`) en el dominio, `undoTicket` en Kitchen y evento `kitchen.order_resumed`.

Lo que hace que esto sea seguro no es que el ticket retroceda, es que **el pedido retroceda con él**. Deshacer el ticket dejando el pedido en «listo» habría dejado a la cocina trabajando en algo que el resto del sistema da por terminado — peor que no deshacer.

Dos barreras, y cada una tapa un abuso distinto:

· **Ventana de tiempo.** Pasados unos segundos ya no es un toque accidental: es una corrección, y una corrección lleva motivo y va por el panel. Sin este límite, «deshacer» sería una forma cómoda de reescribir cuánto tardó la cocina. El servidor da 30 s frente a los 8 de la pantalla: el reloj de una tablet no es el del servidor, y un deshacer legítimo rechazado por medio segundo obliga a llamar al encargado, que es justo lo que esto viene a evitar.

· **El pedido sigue en cocina.** A partir de `packed` está en una bolsa y probablemente en manos de un repartidor: retroceder ahí sería reescribir lo que otra persona hizo después.

Y la prueba de auditoría destapó un tercer caso que yo había cerrado de más: **`accepted` también cuenta como «en cocina»**. El cocinero arranca el ticket y deshace al instante, antes de que el relay haya movido el pedido a `preparing`; mi guardia lo rechazaba justo en el caso más frecuente.

Queda auditado con el estado de origen y destino: sin traza, los tiempos de cocina se vuelven negociables.

### La sexta pieza sin llamador: la mitad saliente de las integraciones

El repaso de piezas huérfanas encontró la más grande hasta ahora. `ChannelConnector` siempre tuvo dos mitades. La de ENTRADA —firma, `identify`, `parseOrder`— se cableó en F4 con la ingesta y funciona. La de SALIDA —`pushMenu`, `setAvailability`, `updateOrderStatus`, `cancelAck`— estaba implementada en el simulador, con sus pruebas en verde, y **no la llamaba nadie**. Los únicos «llamadores» que aparecían al buscar eran las propias implementaciones.

Lo que eso significaba en un local de verdad es exactamente lo que RN-INT-05 advierte entre paréntesis: *el canal sigue vendiendo lo pausado = pérdida*. Se acaba el pollo, el encargado lo pausa en Sahana, el marketplace no se entera y **sigue vendiéndolo**. Cada pedido que entra por ahí es una cancelación, una penalización del canal y un cliente que esperó comida que no existía. Lo mismo con los estados: el canal nunca sabía si su pedido se aceptó o se rechazó.

Ahora hay consumidor. `ChannelSyncService` + `IntegrationsEventHandlers` escuchan `catalog.availability_changed`, `catalog.published` y las transiciones del pedido, y llaman al conector de cada conexión activa de esa marca y canal. Tres decisiones:

· **Se dispara por eventos, no desde Catalog ni Ordering.** Una caída de Rappi no puede impedir pausar un producto ni aceptar un pedido (RN-INT-03).

· **El fallo se propaga a propósito.** El handler comparte transacción con la marca de `inbox`: al lanzar, la marca se deshace y BullMQ reintenta con backoff, que es literalmente lo que pide RN-INT-05. Tragarse el error —como sí hace mensajería, donde un aviso perdido es solo un aviso perdido— aquí dejaría el canal vendiendo un plato agotado sin reintento alguno.

· **Con el cortacircuitos abierto no se propaga.** Machacar a un proveedor que ya se sabe caído no arregla nada y retrasa su recuperación. El contador del circuito no se toca desde aquí: cualquier escritura previa a lanzar se iría con el rollback. Lo abre la ingesta, que sí escribe en su propia transacción; esta ruta solo lo lee.

Va **el último** de los consumidores del worker, porque es el único cuyo fallo es esperable: ponerlo antes retrasaría el ticket de cocina y el aviso al cliente por una llamada a un tercero.

### Y la comprobación para que no haya una séptima

Seis veces ya: `processPending` sin barrido, el consumidor del agente que no existía, `authenticateDevice` sin endpoint, `paymentMethod` descartado en el borde, la venta del POS que nunca llegaba a caja, y esto. Las seis se encontraron a mano, leyendo. `workers/wiring.test.ts` ya vigilaba dos de las tres formas de quedarse sin llamador —barrido sin arrancar, módulo con handlers sin registrar—; ahora cubre la tercera, el evento:

· **Todo evento que se publica o lo escucha alguien, o está justificado por escrito.** Añadir un `enqueueEvent` sin consumidor rompe el build salvo que se apunte en `SIN_OYENTE` con el motivo. Y la lista se audita a sí misma: una excusa cuyo evento ya tiene consumidor también falla, para que no crezca hasta dejar de significar nada.

· **Todo evento que se escucha lo publica alguien.** Un handler con el nombre mal escrito no da error nunca: simplemente no se ejecuta.

Los tipos publicados se leen del fuente; los escuchados se sacan llamando a `handlers()` de verdad, porque varios módulos construyen sus claves con plantillas y una expresión regular se las perdería. Al montarla apareció además un falso positivo instructivo: el primer escaneo dio `order.cancelled` y `order.rejected` como «sin emisor», y resultó que sí los emite `` eventType: `order.${siguiente}` `` — por eso la prueba entiende plantillas y no solo literales.

**Lo que la lista deja al descubierto y queda escrito (DT-13):** tres reglas —RN-ORD-04, RN-BIL-02 y RN-BIL-03— piden **avisar a una persona**, y hoy ese aviso muere en un evento que nadie escucha. El hecho queda registrado y se ve entrando al panel; lo que falta es que el panel te busque a ti. Con un local lo ve el encargado; con diez, no.

### El gate de F5, revisado

`docs/33-gate-fase-5.md` §8. El veredicto no cambia —**APTO CON EXCEPCIONES**, y las cuatro excepciones siguen compartiendo causa: DT-02, no hay entorno cloud—. Lo que cambia es el alcance: cuando se firmó, los ocho criterios de salida y las 37 tareas estaban verificados y **el sistema no se podía usar**, porque no existía ni una sola pantalla de operación.

La lección queda escrita para el gate de F6: **comprobar el backlog no es comprobar la fase.** Un backlog puede estar completo y dejar fuera media spec sin que ningún criterio se ponga rojo — las pantallas estaban especificadas en `specs/ux/`, asignadas a F4–F5, y ningún backlog las incluyó. El gate de F6 empieza por la lista de specs con interfaz declarada y pregunta, una por una, si existe, antes de mirar una sola prueba.

Cifras a hoy: **1 235 pruebas** (441 dominio · 633 API contra Postgres y Redis reales · 117 print-agent · 23 POS · 14 navegador · 7 prompts), 66 casos de aislamiento bloqueantes, 365 módulos sin una violación de frontera y 31 migraciones que admiten volver a la imagen anterior.

### La bandeja de excepciones existe — DT-04 saldada

F6 no se abre todavía: su propia nota de planificación dice que no debería abrirse antes de que los tres pilotos lleven un mes vendiendo, porque el inventario real solo se prueba contra consumo real. Lo que sí estaba vencido y era código es DT-04.

RN-ORD-10 exige que un pedido cuyo catálogo no sabemos mapear **no se descarte**: se aparta. Eso funcionaba desde F4 en la base de datos, y la única forma de sacarlo de ahí era llamar al endpoint a mano. Para el cliente que espera su comida, «perdido» y «apartado donde nadie lo ve» son lo mismo.

Al construir la pantalla aparecieron dos huecos que solo se ven usándola:

· **El payload crudo del canal no lo devolvía nadie.** Se guarda desde F4 en `mapping_failed.data`, con un comentario que dice literalmente «sin él, resolver la excepción sería adivinar»… y `getTimeline` devuelve todos los campos del evento **menos** `data`. El dato estaba a salvo y era inalcanzable, que para quien tiene que resolver la excepción es exactamente lo mismo que no tenerlo. Ahora hay `GET /orders/:id/exception`, con **permiso propio** —el payload lleva el nombre y el teléfono del cliente, y eso no tiene por qué verlo todo el que puede leer pedidos— y **solo mientras el pedido está en revisión**.

· **Mapear a un pollo era imposible.** El primer formulario ofrecía plato y cantidad, y la API respondía 422: «Debes elegir en "Tamaño"». Un plato con talla obligatoria es el caso normal en el Perú, no el raro — la pantalla habría parecido rota el primer día, con el pedido atascado en la bandeja para siempre. Lo destapó la prueba de navegador al elegir el pollo en vez de la bebida.

Tres decisiones más que no son obvias:

· **Se ofrece la carta RESUELTA para el canal del pedido**, no la carta entera. Ofrecer un plato sin precio en ese canal, o pausado, haría que resolver fallara con el operador convencido de haberlo arreglado.

· **Se puede recordar el SKU** para la próxima. Resolver de uno en uno para siempre es pagar cada pedido con trabajo manual; el mapeo permanente va DESPUÉS de resolver y **su fallo no deshace nada** — que el próximo vuelva a apartarse es molesto, perder este no.

· **Rechazar exige motivo.** Sin salida la bandeja solo crece, y una bandeja que solo crece se deja de mirar. El motivo va al canal y a auditoría: «rechazado» a secas no le sirve ni al cliente que esperaba ni a quien revise el mes.

Y esta pantalla **sí usa JavaScript**, al contrario que la tienda: los modificadores obligatorios dependen del plato que se acaba de elegir, y sin JS eso obliga a una ida y vuelta al servidor por línea. La usa un encargado en su escritorio, no un comprador en un móvil con 3G. Sin JS sigue enviándose y sirve para los platos sin nada obligatorio.

### El repaso de `specs/ux/`: dos pantallas más que no existían

El método que destapó DT-09 —leer la lista de specs con interfaz declarada y preguntar una por una si existe— encontró otras dos. De seis specs de UX, cuatro estaban construidas (POS, KDS, panel, tienda) y **dos no existían en absoluto**: el centro de operaciones (`ux/05`, F4 básico / F5 completo) y la bandeja de conversaciones (`ux/06`, F5).

**El centro de operaciones era el grave, y no por estética.** Sin él **no había forma de aceptar un pedido desde ninguna interfaz**. Los canales con aceptación manual dependían de que alguien llamara al endpoint a mano y, a los diez minutos, el barrido de RN-ORD-04 los rechazaba solo. Es decir: **todo pedido manual acababa rechazado, no por decisión de nadie sino por falta de un botón**. El KDS no servía —muestra tickets de cocina, que solo existen a partir de `order.accepted`— y el panel tampoco.

Ya existe, con las tres columnas de la spec. Cuatro decisiones que importan:

· **La cuenta atrás es real y corre en el navegador.** Un plazo pintado en el servidor se congela en la página y miente en cuanto pasa un minuto, y aquí lo que se mira es precisamente cuánto queda antes de que el sistema rechace el pedido solo.

· **El plazo se resuelve con el mismo criterio de especificidad que el servidor**, y eso tiene prueba unitaria propia —la primera de `apps/web`, ahora en CI—. Una copia que se desvía es peor que no tener reloj: el operador ve «te quedan 4 minutos» sobre un pedido que el barrido ya rechazó y se entera cuando llama el cliente.

· **Las excepciones van arriba del todo**, por encima de lo que tiene reloj: un pedido que no se pudo traducir lleva más tiempo esperando que cualquiera de los otros, y su cliente también.

· **La columna de problemas se degrada sola.** Quien no tenga permiso de integraciones o de facturación ve el resto de la pantalla igual, en vez de un error que le impide aceptar pedidos. Y solo se pinta lo que tiene un dato real detrás: una tarjeta de «POS offline > 30 min» sin nada que la alimente enseñaría un verde que nadie ha comprobado.

La prueba de navegador afirma el **movimiento** —el pedido sale de «por aceptar» y aparece en «en curso»— y no un mensaje de éxito: al aceptar, la tarjeta desaparece y se lleva el mensaje con ella, que es el comportamiento correcto.

**Lo que queda escrito y no se hizo (DT-14):** la bandeja de conversaciones. El módulo y el agente están completos y probados, y lo que falta es la pantalla donde una persona atiende. La consecuencia concreta es que **una derivación bot→humano no llega a ningún sitio**: el agente escribe el resumen, marca `handoff_at`, y nadie lo ve. El cliente que pidió hablar con una persona no recibe respuesta.

### La bandeja de conversaciones — DT-14 saldada, y el mismo hallazgo por tercera vez

El módulo de conversaciones y el agente estaban completos y probados desde T5.19–T5.31. Faltaba el sitio donde una persona atiende, y sin él **una derivación bot→humano no llegaba a ningún sitio**.

Y al construirla apareció otra vez el patrón, ya por tercera vez en dos días: **`handoff_summary` y `handoff_at` se escribían desde T5.28 y ninguna ruta los devolvía**. `ConversationView` traía todo menos justo el dato por el que existe la derivación. El traspaso con contexto —lo que evita que el cliente lo cuente todo otra vez, que es el momento exacto en el que la gente abandona— vivía en la base de datos y no ocurría en la práctica. Es la misma forma que el payload crudo de las excepciones (DT-04), y por el mismo motivo: el dato se guarda con un comentario que explica para qué, y nadie comprueba nunca que se pueda sacar.

Tres decisiones de la pantalla:

· **El resumen se pinta ANTES que el hilo**, con los datos ya capturados en una lista. La spec pide que el agente conteste en menos de diez segundos sin releerlo todo, y eso no se consigue enseñándole cincuenta mensajes en orden.

· **Con la ventana de 24 h cerrada no se deja escribir texto libre** (RN-CNV-03). Dejar pasar el texto y que Meta lo descarte en silencio es el peor de los dos mundos: el agente cree que respondió y el cliente no recibe nada. La nota interna sí queda habilitada — apuntar algo para el turno siguiente no manda nada a nadie.

· **El autor va escrito en todas las burbujas**, no solo el color y el lado. «¿Esto lo dijo la IA o una persona?» no puede depender de que alguien interprete el diseño. Y la nota interna va en amarillo y lo dice: es la única burbuja que no salió del edificio.

Las dos pruebas de navegador afirman el **efecto** y no un mensaje de éxito: al tomar la conversación el botón desaparece y deja de decir «sin asignar». Es la misma corrección que hizo falta en la torre de control — al revalidar, el componente se desmonta y se lleva su mensaje, que es el comportamiento correcto.

**Estado de `specs/ux/`: las seis specs tienen pantalla.** POS, KDS, panel, tienda, centro de operaciones y bandeja. Lo que queda del panel son secciones que la spec 03 enumera y que aún no existen —Pedidos con buscador y timeline, Inventario, Caja y comprobantes, Clientes, Configuración completa, Novedades—, todas de consulta y ninguna bloqueante para operar.

### Pedidos: buscador y trazabilidad — y el criterio nuevo cazando su primera pieza

El criterio de entrada de F6 que acababa de escribir (§8.8 del gate) tiene un paso 2: «para cada dato que se escribe con un comentario que explica para qué sirve, ¿hay una ruta que lo devuelva?». Aplicado a `ord_order_lines`, la respuesta era **no**, y van cuatro.

Las líneas del pedido se guardan desde F4 con el comentario que explica que son un **snapshot** —«no se referencia el catálogo, se copia» (RN-ORD-02)— y ninguna ruta las devolvía. Quien atendía «¿dónde está mi pedido?» podía ver el estado y el total, y no **qué pidió el cliente**. El snapshot existe justamente para poder responder eso meses después, cuando el producto ya cambió de nombre o de precio.

Ahora hay `/panel/pedidos` con buscador y `/panel/pedidos/[id]` con la trazabilidad de la spec 03. Cuatro decisiones:

· **Se busca por número, referencia del canal, teléfono y nombre** — las cuatro cosas que una persona dice por teléfono. El número va por **igualdad** y no por coincidencia: quien dice «mi pedido es el 12» no quiere ver el 120, el 121 y el 312. Los otros tres sí van parciales, porque el teléfono se dicta a medias y el nombre se escribe de diez maneras.

· **El detalle va aparte de `GET /:id`** en vez de engordarlo. El resumen lo consume el POS en cada sincronización y no necesita las líneas —ya las tiene—; cargarlas ahí sería mandar el pedido entero por la red en cada respuesta del mostrador.

· **El historial se pinta del más reciente al más antiguo**, y distingue «Sistema» de «Una persona». Un rechazo automático por vencimiento y uno que alguien decidió no se explican igual al cliente ni al canal.

· **El importe se formatea cortando la cadena de dígitos**, no dividiendo por `10 ** scale`. La forma obvia es la prohibida por CLAUDE.md; esta además es exacta para cualquier magnitud.

El buscador nuevo llevó su propia prueba de aislamiento: es un vector clásico —basta con que la condición de texto se aplique sin la de tenant para que un negocio encuentre a los clientes de su competencia por el teléfono—.

### Caja y comprobantes

El paso 2 del criterio se aplicó primero, y esta vez pasó limpio: `cash-sessions`, su resumen y `documents` ya exponían todo lo que la pantalla necesita. Faltaba solo la pantalla.

`/panel/caja` enseña los turnos con su diferencia y los comprobantes con su estado; `/panel/caja/[id]` es el arqueo. Lo que hace que ese detalle valga son **dos vistas que el servidor ya calculaba y que no leía nadie**: por tipo en efectivo —lo que explica el esperado— y por medio de pago, incluidos los que no tocan la gaveta. Sin la segunda, un turno con mucha tarjeta parece un faltante enorme y el cajero acaba defendiéndose de una acusación que era un error de lectura. La prueba de navegador afirma exactamente eso: fondo 50 + venta en efectivo 32 − salida 10 = **72**, con la venta de 45 con tarjeta fuera del esperado y dentro del desglose.

El formateo de importes se unificó en `caja/dinero.ts` —tres pantallas lo usaban y una tercera copia habría acabado siendo la que se desvía— y tiene prueba propia: la forma obvia, `minorUnits / 10 ** scale`, es la prohibida por CLAUDE.md, así que corta la cadena de dígitos. Los casos que valen son los que distinguen un corte correcto de uno que «funciona con los números de hoy»: 0.05, importes negativos, y 99 999 999.99, donde una división ya pierde el último céntimo.

**Dos aserciones mías que estaban mal, y lo que enseñan.** La del buscador prometía que buscar «12» solo devuelve el pedido 12; el código —a propósito— también encuentra teléfonos que contienen 12, porque quien dicta «termina en 12» busca así. Pasó en aislamiento y falló con la suite completa, que es cuando aparecieron teléfonos con esos dígitos. La aserción correcta no es «solo sale el mío» sino la que aísla el fallo real: **ningún resultado tiene un número que contenga los dígitos sin ser igual a ellos**. Y la de caja buscaba el texto «Tarjeta», que también está en el párrafo que explica la tabla: ahora busca la celda.

### Inventario: el kardex se podía escribir y no leer

El paso 2 del criterio, aplicado a inventario y CRM antes de tocar nada. CRM salió limpio —no hay módulo porque la fase no lo pide; lo mínimo que la bandeja necesita vive en `wa_contacts`, y eso es alcance planificado, no un hueco—. Inventario, no.

**`inv_movements` se escribía en tres sitios desde F4 y ninguna ruta lo devolvía.** Y es la tabla que RN-INV-02 declara append-only: `UPDATE` y `DELETE` están revocados al rol de aplicación precisamente para que el libro sea auditable. Un libro inalterable que nadie puede leer no es auditable, es solo inalterable. La restricción que obliga a poner motivo en cada ajuste y cada merma existe para que la respuesta a «¿por qué faltan 3 kg de carne?» no sea «alguien lo ajustó» — y hasta ahora esa respuesta seguía sin poder darse, porque el motivo estaba escrito donde nadie llegaba.

Van cinco veces. Ahora hay `GET /inventory/movements` con filtro por insumo, almacén y pedido, y `/panel/inventario` con existencias y kardex.

Tres detalles que importan:

· **La cantidad viaja con signo**, tal como está en la tabla. Quitarle el signo obligaría a la pantalla a deducirlo del tipo, que es justo la tabla de signos que la migración evitó a propósito: una reversa suma y una merma resta bajo tipos distintos, y un ajuste puede ir en cualquier dirección.

· **Se devuelve el costo unitario del momento** (RN-INV-04), no el de hoy. Es el dato del que depende todo F6: sin poder mirarlo, «teórico vs real» no se puede ni empezar a conciliar. Que estuviera guardado y fuera ilegible convertía la precondición de la fase siguiente en un acto de fe.

· **Cada movimiento enlaza a su pedido**, para poder saltar de «falta pollo» a «este pedido se lo llevó».

La prueba de aislamiento no es de trámite: el kardex lleva el costo unitario de cada consumo, así que quien lo lea sabe cuánto le cuesta a la competencia cada plato que vende.

### La mitad de escritura del inventario

`InventoryAdminService`: insumos y recetas, idempotentes por clave natural (SKU, o nombre si no hay; para recetas, el producto del que cuelgan). Era el mismo hueco que tenían catálogo y organización antes de DT-10 — sin él, un negocio nuevo no podía declarar nada sin SQL, y sin receta el consumo automático no se dispara: el food cost, que es la razón de ser del módulo, se quedaba en cero para todos menos para la pollería de las semillas.

Una regla que parece burocracia y no lo es: **la unidad de un insumo no se puede cambiar si ya se movió**. Stock, kardex y recetas guardan números *sin* unidad —vive en el insumo—, así que pasar de gramos a mililitros no convierte nada: reinterpreta todo el histórico. 20 000 g de pollo se volverían 20 000 ml de la nada y el food cost de meses cerrados cambiaría sin que nadie tocara un movimiento. Es 409 y no 422 a propósito: el dato que se manda es válido, lo que no se puede es aplicarlo con ese histórico detrás.

**Y dos defectos míos que encontró una aserción, después de que la aflojé y la volví a apretar.** La prueba del ciclo decía `status >= 400` y pasaba. Al cambiarla por `422` + código `RECIPE_CYCLE` salió un **500**: la restricción `sin_autorreferencia` de la base saltaba antes que mi código y el error de Postgres se escapaba tal cual al cliente. Arreglado con una comprobación explícita y un mensaje entendible, dejando la restricción como última línea de defensa.

El segundo es peor y lo destapó el primero al mirarlo de cerca: **yo validaba la receta después de confirmar la transacción**. Escribí un comentario justificándolo —no bloquear filas mientras se recorre el árbol— y era una mala decisión: un ciclo A→B→A se guardaba, la petición fallaba, y el operador se quedaba convencido de que no se había guardado nada mientras el ciclo esperaba al primer pedido de las ocho. Ahora se valida dentro de la transacción, con el mismo `ctx`, y hay una prueba que comprueba justo eso: tras el rechazo, la receta A sigue teniendo su componente original.

La lección, que es la misma de la aserción del buscador: **una aserción laxa no es una prueba tolerante, es una prueba que no mira**. Las dos veces que apreté una, apareció un fallo real debajo.

### El alta por archivo da de alta un negocio COMPLETO

`setup-business` incluye ahora insumos y recetas. La sección va al final del archivo y de la ejecución a propósito: una receta cuelga de un producto, y declararla antes obligaría a resolver referencias hacia adelante y a que el orden del archivo importara de una forma que nadie recuerda al escribirlo. Las subrecetas sí tienen que ir antes de quien las usa, y el error lo dice con esas palabras.

**Y el ejemplo destapó un hueco que ninguna prueba veía: un local puede no tener almacén.** El alta creaba empresa, marcas, locales, cocinas, estaciones, zonas, horarios y carta — y ningún almacén. Con eso el negocio vende con toda normalidad y **revienta al aceptar el primer pedido con receta**, con un `WarehouseNotConfiguredError` que llega por el consumidor de eventos: en el worker, donde nadie lo está mirando, y con la venta ya cobrada. Ahora `upsertWarehouse` existe en la API de organización y el alta crea el almacén **siempre que el archivo declare inventario**, se haya nombrado o no. Dejarlo opcional de verdad habría sido dejar la trampa puesta.

Lo encontré porque la prueba del ejemplo no se queda en «el pedido cobra el precio del archivo»: ahora **lo acepta y comprueba el kardex**. 1200 g de pollo más un 5 % de merma son 1260 g descontados, y la subreceta de crema aparece estallada en mayonesa y ketchup, no como una línea. Sin ese paso, el ejemplo habría seguido pasando en verde con el agujero dentro — que es exactamente lo que llevaba pasando.

### El equipo: no había forma de crear un segundo usuario

Antes de bajar por lo que queda de `specs/ux/03` comprobé si algo de ahí era bloqueante y no consulta. Lo era, y es de los peores que han salido: **no existía ninguna forma de crear un usuario**. Los nueve roles del sistema se crean en cada tenant, el guardia los comprueba en cada petición y el POS entra con usuario + PIN… y el único usuario era el propietario que nace con el negocio.

Lo que pasa en un local sin eso es concreto y no hace falta imaginarlo: el dueño le da SU contraseña al cajero. Es la cuenta que aprueba descuadres, cambia precios y firma en `audit_log`. **La trazabilidad se vuelve ficción el primer día** — todo lo hizo el dueño, incluso lo que hizo el cocinero a las once de la noche. Y esa trazabilidad es la que sostiene la regla de CLAUDE.md de que auditoría es deuda inaceptable.

`UserAdminService` + `/panel/equipo`. Cuatro reglas que no son de formulario:

· **El rol es obligatorio al dar de alta.** Una cuenta sin rol entra y no puede hacer nada, y lo que ocurre entonces es que alguien le presta una con permisos «mientras tanto» — el atajo que la pantalla existe para evitar. Pedirlo cuesta un desplegable; no pedirlo cuesta la trazabilidad entera.

· **`owner` no se puede asignar nunca.** Que un administrador pueda fabricar otro propietario convierte cualquier cuenta de administrador comprometida en una toma de control permanente.

· **Al propietario no se le cambia el rol ni se le desactiva.** Es la única cuenta sin escalón por encima al que pedir ayuda: dejarla fuera deja el negocio sin nadie que pueda recuperarlo.

· **Cambiar de rol reemplaza, no acumula.** Acumular deja cajeros que siguen aprobando descuadres porque un día cubrieron un turno de supervisor, y quitarlo exige saber cuántos roles se dieron antes — que nadie sabe.

Los roles que ofrece el desplegable **los sirve el servidor**, no la pantalla: son los mismos nueve que comprueba el guardia, y una lista duplicada se desviaría el día que se añada uno, ofreciendo un rol inexistente o escondiendo uno real.

La pantalla dice además quién **no tiene PIN**, porque tener cuenta y no poder abrir caja en el POS es una forma silenciosa de no estar dado de alta.

### …y dar de alta no bastaba: al POS se entra con un PIN y una tablet

Al terminar la pantalla apliqué el paso 2 del criterio de §8.8 —«¿hay ruta que devuelva lo que se escribe?»— y salió otro hueco de la misma familia, esta vez al revés: **la API estaba completa y la pantalla no la llamaba**. `POST /devices/pairing-codes`, `POST /devices/pair`, `GET /devices`, `DELETE /devices/:id` y `POST /auth/pin` existen desde F3, con bloqueo por intentos y todo. Sin pantalla, dar de alta a alguien lo dejaba a medio camino: cuenta sí, POS no, y ninguna forma de poner en marcha una tablet que no fuera un `curl`.

Ahora `/panel/equipo` pone el PIN por persona, emite el código de emparejamiento y revoca dispositivos. Tres detalles que no son de formulario:

· **El código se enseña UNA vez y no se guarda.** Es la credencial con la que un aparato sin cuenta entra al sistema. La acción **no llama a `revalidatePath` a propósito**: emitir un código no crea ninguna fila —el dispositivo nace cuando la tablet canjea—, así que no hay nada que refrescar, y el remontaje se llevaría por delante el único momento en que el código está en pantalla.

· **El segundo canje falla con 403, no con 422**, y con un mensaje que no distingue «ya usado» de «no existe» ni de «caducado». Decirlo confirmaría a quien prueba códigos cuáles fueron válidos alguna vez. El «un solo uso» lo garantiza la base de datos con un `UPDATE` condicional sobre `used_at`, no el orden de las llamadas.

· **Revocar exige motivo.** Una tablet revocada sin explicación deja sin respuesta la única pregunta que importa después: si se perdió o simplemente se devolvió.

### Las aprobaciones de dos personas las daba una sola

Con el equipo y los dispositivos cerrados, apliqué el paso 2 de §8.8 a lo que
queda de superficie sin pantalla y acabé mirando los tres sitios donde el
sistema exige **doble aprobación**. Los tres comprobaban menos de lo que su
propio comentario decía comprobar, y en los tres el comentario era correcto
sobre lo que hacía falta:

· **Reembolso sobre el umbral (RN-PAY-03).** Solo comparaba dos identificadores,
y los dos los escribe quien pide. Bastaba con poner el id de una compañera —que
`GET /users` devuelve a cualquiera con `users.read`— para aprobarse mil soles
sin que ella se enterara de nada. **No pedía PIN en absoluto.**

· **Descuadre de caja (RN-POS-02).** Pedía el PIN de «un supervisor» y no
comprobaba que fuera otra persona: el cajero ponía su propio id y su propio PIN
y firmaba su propio faltante.

· **Descuento sobre el umbral (RN-T08).** Lo mismo, y encima con un umbral que
existe justo para que un descuento grande lo mire alguien más.

Las tres se arreglan en un solo sitio, `DeviceService.authorizeApproval`, que
exige las tres cosas a la vez y no dos: **que sean dos personas**, **que la
segunda lo demuestre ahora** (PIN, con el bloqueo por intentos de RN-IDN-03) y
**que pueda** —el permiso que autoriza la acción, que por eso no puede ser uno
que ya tenga quien la pide—. Para caja hizo falta un permiso nuevo,
`cash.approve_difference`, que el cajero **no** lleva: sin un permiso que él no
tenga, la «aprobación del supervisor» la da él mismo. Ocho pruebas nuevas, una
por cada forma concreta de saltárselo.

**Y eso destapó la pieza que faltaba debajo:** los roles del sistema se siembran
**una sola vez, al dar de alta el tenant**. Un permiso nuevo del catálogo llega
a los clientes futuros y **a ningún cliente actual** — el código empieza a
exigirlo el día del despliegue y ningún rol lo tiene. Lo que se ve entonces desde
el local no se parece a un problema de permisos: se parece a que la caja no
cierra. `pnpm sync:roles` reconcilia todos los tenants, es idempotente, **solo
añade** —el catálogo es el mínimo de cada rol, no su techo— y está escrito en
`docs/34` como paso del despliegue, no como rescate.

### La cola de corrección no se podía corregir

Siguiendo el mismo criterio, el siguiente sitio donde la pantalla pedía algo
imposible era la columna de problemas de operaciones: enseñaba los comprobantes
rechazados por la OSE con el texto «hay que corregir y reenviar». **Corregir no
se podía.**

RN-BIL-02 dice «documento rechazado por OSE → cola de corrección; NUNCA se
pierde la venta», y la cola existía desde F4: el documento se quedaba en
`rejected` con el motivo al lado. Lo único expuesto era `retry`, que reenvía
exactamente el mismo RUC que la OSE acaba de rechazar, y `POST /documents` se
niega —bien— porque la venta ya tiene comprobante. La venta no se perdía, que es
lo que la regla exige literalmente; pero se quedaba **sin poder facturarse
nunca**, que ante SUNAT viene a ser lo mismo.

`POST /documents/:id/correct` cambia la identidad del cliente y reenvía. Tres
decisiones que no son de formulario:

· **Se conserva el número.** Un rechazado nunca fue válido, así que reenviarlo
corregido con su mismo correlativo es lo correcto. Darle uno nuevo dejaría el
anterior como un hueco en la serie, y un hueco hay que justificarlo con una
comunicación de baja — justo lo que RN-BIL-01 existe para evitar.

· **Solo desde `rejected`.** Uno aceptado ya está declarado y se revierte con
nota de crédito, no editándolo.

· **De factura a boleta no es corregir.** Son series y correlativos distintos:
es otro comprobante, y el mensaje lo dice con esas palabras en vez de emitir en
silencio en la serie equivocada.

Y para poder corregir hubo que **enseñar lo que se corrige**: `DocumentView` no
devolvía a nombre de quién iba el comprobante. La pantalla habría pedido
escribir el RUC a ciegas, sin ver el que la OSE rechazó.

La pantalla `/panel/comprobantes` deja el motivo de la OSE a la vista mientras
se escribe el dato nuevo, valida el RUC antes de salir —gastar un envío en un
RUC de nueve dígitos es tirar un intento— y dice el **desenlace** del reenvío,
no «enviado»: que lo vuelvan a rechazar es el caso normal, y ocultarlo hace que
alguien pulse el botón diez veces.

### Devolver dinero exigía un `curl`

Tercer sitio de la misma familia, y el que más incomoda: **`POST
/payments/intents/:id/refund` no lo llamaba nada en la interfaz**. Existe desde
T5.05, con su umbral, su doble aprobación y sus pruebas; devolverle el dinero a
un cliente exigía entrar al servidor.

Al construir la pantalla salieron las dos mitades que faltaban debajo, las dos
con el mismo patrón de siempre:

· **El motivo de la devolución.** `refund_reason` se escribe desde T5.04 con el
comentario «va al panel y a la auditoría». A la auditoría iba; al panel no,
porque ninguna ruta lo devolvía.

· **La alarma que nadie podía oír.** La migración 0020 dice, sobre
`refund_attempts`: «una pasarela caída no puede dejar el dinero retenido para
siempre en silencio: pasado el límite, esto es una alarma operativa que alguien
tiene que atender a mano». El barrido efectivamente se rinde tras cinco intentos
—y hace bien— pero **no había ningún sitio donde eso apareciera**: el cobro se
veía en el panel igual que cualquier otro, con el dinero del cliente retenido y
el cliente llamando. Ahora `GET /payments/refunds/stuck` los saca y la columna
de problemas de operaciones los pone arriba, con el error que devolvió la
pasarela y un enlace al pedido.

En la pantalla, los campos de la segunda firma se enseñan **siempre**, no solo
cuando la API se queja: quien va a devolver un importe grande ya sabe que
necesita a alguien al lado, y enterarse después de rellenar el motivo es peor.
El aprobador se elige de una lista de quienes **pueden** firmar; ofrecer a todo
el equipo solo conseguiría que la mitad de los intentos muriera con «no tiene el
permiso». Y el mensaje dice «en cola», no «devuelto»: el dinero lo mueve el
barrido, y prometer por la pasarela es una promesa que el cliente comprueba en
su banco.

**Un apunte de entorno que costó una vuelta:** tras `seed:shop` hay que
**reiniciar la API**. El sandbox del OSE recuerda en memoria qué números registró
y la semilla rehace el tenant con el mismo RUC y la misma serie, así que el
F001-00000001 nuevo es, para el sandbox, otro documento con un número ya visto:
1033. Es el comportamiento correcto —un OSE real haría lo mismo— y por eso se
resuelve reiniciando el proceso y no relajando la comprobación. Queda escrito en
la cabecera de `seed-shop.ts`.

### El contrato de auditoría no lo comprobaba nadie

Toda la trazabilidad que sostienen los tres cambios anteriores —cada cuenta con
su nombre, cada descuadre firmado por dos, cada comprobante con su corrección—
acaba en `audit_log`. Al ir a construir la pantalla apareció algo peor que una
pantalla que falta.

`AUDITED_ACTIONS` decía ser «las acciones auditadas obligatoriamente
(docs/14#auditoria)». Era una lista de nombres bonitos que **no coincidía con lo
que el código escribe**: enumeraba `price.changed`, `permissions.changed` y
`order.refunded`, y el código escribe `catalog.price_set`,
`identity.role_changed` y `payment.refunded`. **Diez de sus diecisiete entradas
no las emitía nadie.** Y nada lo comprobaba, porque la constante no la usaba
ningún camino de ejecución: parecía un contrato y era una nota.

Esto no se nota nunca por sí solo — **nadie echa de menos una línea de auditoría
que no sabe que debería existir**. Se nota el día que hay que demostrar quién
cambió un precio, y ya es tarde. CLAUDE.md dice que la deuda de auditoría no es
aceptable nunca, así que se arregla ahora:

· `AUDIT_REQUIREMENTS` mapea **requisito de docs/14 → nombres reales** que lo
satisfacen, y `auditoria-contrato.test.ts` falla en cuanto uno se queda
huérfano. Comprobé que la prueba muerde de verdad rompiéndola a propósito —y de
paso descubrí que se aprobaba a sí misma, porque el nombre aparecía en el mapa
que la propia prueba leía; ahora el archivo del contrato queda excluido del
barrido.

· `AUDIT_REQUIREMENTS_PENDING` declara los dos que **no tienen emisor**:
`support.cross_tenant_access` (no existe acceso de soporte cross-tenant;
`recordAudit` ya exige motivo para ese caso, así que el día que se construya no
se podrá escribir sin él) y `data.bulk_export` (no hay ningún endpoint de
exportación masiva). Se declaran en vez de omitirse: una lista que solo contiene
lo hecho no distingue «cumplido» de «olvidado».

Y la pantalla, `/panel/auditoria`. El endpoint devolvía las filas crudas, con el
actor en UUID: «3f2a8c… cambió un precio» no contesta la pregunta que trae a
alguien a la auditoría, que **siempre es quién**. El nombre no se guarda en la
fila a propósito —una persona se renombra y el histórico no se reescribe— así
que se resuelve al leer, con `LEFT JOIN`: quien firmó puede haberse dado de
baja, y perder su línea por eso sería lo contrario de auditar. El filtro por
acción se ofrece con **las acciones que hay**, contadas, no con una lista escrita
a mano que se desviaría al añadir una.

### El reparto no tenía pantalla, en un producto que vive del reparto

El módulo de reparto está entero desde T5.15: repartidores con sus zonas, el
ranking de asignación de RN-DLV-01 **con el motivo de cada candidato**, estados
del envío, evidencia de entrega, saldos contra entrega y liquidación contra caja
(RN-DLV-02). Con pruebas. Y **sin una sola pantalla**.

En un SaaS para dark kitchens *con delivery* eso significa que el pedido se
cocina, se empaca y ahí se queda: no había forma de dar de alta a un repartidor,
ni de crear el envío, ni de asignarlo. La comida sale igual —alguien la lleva—
pero el sistema no se entera: el cliente no tiene seguimiento, el efectivo que
trae el repartidor no cuadra contra ninguna caja, y el histórico de tiempos de
entrega está vacío justo en el negocio que vive de esos tiempos.

`/panel/reparto` es la mesa de despacho: listos-sin-envío, por asignar, en la
calle, fallidos, la plantilla de repartidores y el efectivo por liquidar. El
desplegable de asignación enseña **el motivo** de cada candidato, no solo el
orden: quien decide es una persona, y una recomendación sin explicación no se
sigue, se ignora.

**Y quedó una pregunta abierta, no una decisión inventada (PA-08):** hoy el
envío **no nace solo** al aceptar un pedido a domicilio; solo lo crea una llamada
explícita. La pantalla lo tapa con la columna «listos, sin envío», pero cuándo
nace un envío es una decisión de dominio que la spec 09 no fija, así que va a
`docs/22-risks.md` para que la resuelva el propietario.

### Y el buscador de pedidos nunca buscó

Al construir la mesa de despacho, una prueba de navegador aterrizó en el pedido
equivocado y destapó esto: **`/panel/pedidos` devolvía la lista entera sea cual
fuera el término**. La pantalla pasaba `search: q` y el cliente de API lo tiraba
al suelo —llega por propagación de un objeto, así que TypeScript no dice nada—.

Lo peor no es el fallo: es que **la prueba que lo vigilaba pasaba**. Comprobaba
que hubiera una primera fila y que su detalle enseñara líneas, y con el buscador
roto siempre hay una primera fila. En la pantalla que se abre cuando suena el
teléfono, eso es atender a un cliente mirando el pedido de otro. Ahora la prueba
comprueba **que el resultado sea el que se buscó**.

### El sistema dejaba de vender y nadie podía verlo ni deshacerlo

La saturación de cocina (T5.18, RN-KIT-04) **pausa canales sola** cuando el
segundo umbral se supera: deja de aceptar pedidos por el canal de menor margen
para salvar los que ya están dentro. Es correcto. Lo que no lo era: no había
ninguna ruta que dijera **qué canales están cerrados**, ni ninguna forma de
abrirlos a mano.

`pausedChannels` existía desde F5 con el comentario «**para el panel y el KDS**»
—otra vez el mismo patrón— y no la exponía nadie. Lo que se vive en el local es
que las ventas se paran de golpe sin explicación, y a las nueve de la noche, con
la cocina ya despejada, no hay ningún sitio donde volver a abrir. Y al revés: el
encargado que se queda sin pollo no puede cerrar Rappi sin llamar por teléfono a
quien tenga acceso al servidor.

`GET/POST /orders/channel-pauses` y la sección **Canales** de la torre de
control, arriba del todo a propósito: si un canal está cerrado, la columna «por
aceptar» estará vacía por un motivo que no es que no haya clientes. Sin eso, la
pantalla dice «todo tranquilo» mientras el negocio no vende.

Cuatro decisiones:

· **Permiso propio, `orders.pause_channels`,** que lleva el supervisor. No va con
`orders.transition` —eso es operar los pedidos que ya entraron— ni se queda solo
en el dueño: quien está mirando la cocina a las nueve es el encargado de turno.
Es el primer permiso nuevo desde que existe `pnpm sync:roles`, así que llega a
los clientes actuales por el camino que se construyó para eso.

· **Cerrar exige motivo**, por lo mismo que rechazar un pedido: el turno
siguiente tiene que saber si puede reabrir.

· **La pausa puede caducar.** Una puesta a las nueve de la noche sin caducidad
sigue puesta a las ocho de la mañana, y quien la puso ya se fue a casa.

· **La pantalla dice QUIÉN cerró.** Una pausa automática se levanta sola al bajar
la carga; una manual, no. Sin distinguirlo, la gente espera a que se abra sola
un canal que no va a abrirse.

De paso, un id de local ajeno chocaba contra la clave foránea y salía un **500
con SQL dentro**: RLS impedía el daño, pero el error no decía nada y parecía una
avería nuestra. Ahora se comprueba el local y responde 404.

### Los umbrales que deciden cuándo dejar de vender

Cierra el par con la pantalla anterior. Ver y deshacer las pausas estaba hecho;
lo que las **causa** —los umbrales de RN-KIT-04— seguía siendo solo API: el dueño
veía su negocio dejar de aceptar pedidos a las ocho y media sin ningún sitio
donde decir «aguanta hasta cuarenta platos». Y el histórico de niveles se
guardaba desde T5.18 con el comentario «para discutir el umbral **con datos, no a
ojo**» sin que ninguna pantalla lo devolviera, así que la discusión seguía siendo
a ojo.

`/panel/cocina`: carga actual por estación —el cuello de botella casi nunca es la
cocina entera, es una estación, y subir el umbral general es la respuesta
equivocada a un horno lento—, los dos umbrales con lo que hace cada uno escrito
al lado, el orden de cierre con la sugerencia por comisión, y el histórico.

**Los dos umbrales se validan uno contra otro** antes de salir: el de pausa tiene
que ser mayor que el de extensión, porque primero se alarga la promesa —se sigue
vendiendo— y solo después se cierran canales. Al revés, el dueño apaga sus
ventas creyendo que las protege.

### Y un defecto de formulario que llevaba en todo el panel

Al probarlo apareció algo que no era de esta pantalla: **una acción de servidor
que falla vuelve a renderizar la página, y con ella el formulario — los campos
vuelven a su valor por defecto y se pierde todo lo tecleado.** En un formulario
de un campo se nota poco. En este, que tiene cinco, equivocarse en uno significa
volver a escribir los otros cuatro; y a la segunda vez la gente deja de corregir
y guarda cualquier cosa.

La acción devuelve ahora **lo que la persona escribió** junto con el error, y el
formulario lo prefiere sobre lo guardado. Lo encontré porque la prueba de
navegador fallaba de una forma que no cuadraba —el guardado bueno ni siquiera
llegaba a la API—, no porque estuviera buscándolo: sin la prueba, esto se habría
descubierto con un cliente delante.

### Las dos preguntas que justifican el producto no tenían pantalla

`GET /analytics/profitability` y `GET /analytics/reconciliation` existen desde
T4.29, con pruebas, y no los pintaba nada.

· **Rentabilidad por marca y canal.** Es *la* pregunta de una dark kitchen:
cuatro marcas en la misma cocina y saber cuál gana dinero por cuál canal. Sin
esa tabla, seguir o no en un marketplace se decide mirando la facturación — que
es justo el número que más engaña, porque el canal que más factura suele ser el
que más comisión cobra.

· **Cuadre con facturación.** La spec 16 lo dice sin matices: una divergencia es
un **bug crítico**. Un panel que dice S/ 12 000 y una declaración que dice
S/ 11 400 no es un redondeo: es que alguien va a decidir con un número que no es.
Se comprobaba por API y no lo miraba nadie.

`/panel/reportes`. La tabla va **ordenada por margen, de peor a mejor**, no por
facturación: la pregunta es cuál gana dinero, y ordenar por ventas pondría arriba
justo al que puede estar perdiéndolo. Un margen negativo no es una fila más — sale
como aviso arriba, porque es dinero que se pierde en cada pedido y vender más
empeora. El porcentaje se calcula con **aritmética entera** sobre los puntos
básicos: es el número que decide si se cierra un canal.

La pantalla dice también de dónde sale cada columna, incluida la trampa: el food
cost viene del consumo real de inventario, así que **un plato sin receta no
aporta coste y parece que deja más margen**. Un informe que no lo advierte
recomienda vender justo lo que no está medido.

**Y otra prueba que pasaba por la razón equivocada.** Al sembrar ventas
entregadas de verdad, la prueba de la portada se rompió: buscaba el texto
«Ventas» y hasta ahora solo existía en la tarjeta de KPI **porque las tablas por
marca y por canal estaban siempre vacías**. Con datos reales aparecen tres veces.
Acotada al rótulo de la tarjeta.

### El agente de IA: el módulo con más superficie y cero pantalla

Identidad, reglas deterministas, versiones con publicación y vuelta atrás,
fuentes de conocimiento, sandbox y presupuesto. Todo construido en T5.19–T5.32,
todo probado, **todo inalcanzable**.

Y aquí la consecuencia es peor que en los otros módulos, porque el agente
**habla en nombre del negocio, por escrito, a clientes reales**. Sin pantalla,
lo que diga es lo que quedó sembrado el día del alta: si el tono no encaja, si
promete algo que no se cumple o si contesta sobre un tema del que no debería, no
había forma de corregirlo — y sí la había de que siguiera hablando.

`/panel/agente`, por marca porque cada una habla distinto. Lo que la pantalla
insiste en dejar claro:

· **Guardar no es publicar.** Son dos botones y dos estados, porque lo que el
negocio dice por escrito no puede cambiar porque alguien tocó un campo y se fue
a comer. La pantalla dice qué versión está publicada y desde cuándo.

· **El sandbox devuelve la traza, no solo la respuesta.** Qué regla disparó, qué
fuentes usó, qué dijo el validador y cuánto costó. Sin eso, «me contestó raro»
no se puede depurar; con eso se ve si fue una regla, el modelo o una fuente
desactualizada. La alternativa —editar en vivo y ver qué pasa— se prueba con
clientes reales.

· **El presupuesto agotado no es «el bot dejó de contestar».** Las reglas
deterministas siguen funcionando siempre (ADR-0011) y la pantalla lo dice con
esas palabras, porque «agotado» a secas se lee como una avería.

· **Las fuentes no llevan precios ni stock.** Un precio escrito en una fuente
queda congelado y el bot lo repetirá cuando ya no sea verdad; eso se consulta en
vivo. El aviso está junto al campo, que es donde sirve.

· El contador de **veces usada** de cada regla: una regla con cero usos en
semanas no está protegiendo nada — o no coincide nunca, o llega tarde por
prioridad.

### Por dónde entran los pedidos

Dos cosas que un negocio necesita el primer día y que solo se podían hacer por
API:

· **Conectar un marketplace.** `POST /integrations/connections` existía sin que
lo llamara nada, así que dar de alta un canal exigía un `curl` con el secreto de
firma dentro. Y la torre de control enseñaba los conectores degradados **sin
ninguna forma de reactivarlos**: se veía el problema y no se podía tocar.

· **El dominio de la tienda.** Se podía registrar y verificar por API, y **no
existía forma de listarlos**: el dato más importante de la tienda —en qué
dirección vive— no lo devolvía ninguna ruta. Quien registrara un dominio y
cerrara la pestaña perdía el token de verificación, y con él la única manera de
activarlo.

`GET /storefront/domains` (con `storefront.read`, no con `manage_domains`: mirar
dónde vive la tienda es una consulta, y quien atiende pedidos tiene que poder
responder «entra en tal dirección» sin permiso para cambiarla) y la pantalla
`/panel/canales`.

Tres detalles que no son de formulario:

· **El token de verificación se enseña las veces que haga falta.** No es un
secreto: es un valor que hay que publicar en un registro TXT para demostrar que
el dominio es tuyo. Ocultarlo haría imposible el paso que existe para
verificarlo. El secreto de firma del canal, en cambio, no se vuelve a enseñar
nunca — ni al dueño: la API lo devuelve redactado.

· **El cortacircuitos se enseña con palabras.** Un conector con el circuito
abierto no recibe pedidos ni cambios de carta, y por fuera se parece a «hoy hay
poca venta».

· **Solo se ofrece el simulador** como conector. Los reales llegan en F7 y
ofrecerlos aquí sería prometer una integración que no existe; el simulador habla
el mismo protocolo, así que lo que se pruebe vale.

### A quién se le puede escribir, y con qué permiso

`wa_consents` guarda **el texto exacto que aceptó la persona** —la migración lo
dice: «el requisito que no se puede reconstruir después»— y `opted_out` decide
en cada envío si se manda. Las dos cosas funcionaban perfectamente y **ninguna
ruta las devolvía**: la baja se respetaba y nadie podía comprobarla.

Eso importa el día que alguien dice «pedí que no me escribieran». La respuesta
era mirar la base de datos a mano. Ahora `/panel/mensajeria` enseña quién está de
baja, desde cuándo, por qué vía y **con qué palabras**.

Tres decisiones:

· **El histórico se pide por contacto, nunca en bloque.** Una lista completa de
textos de consentimiento es justo el volcado de datos personales que no debe
existir como pantalla.

· **Dar de baja a mano se puede siempre.** Si alguien lo dice por teléfono,
exigirle que escriba «BAJA» por WhatsApp sería usar la herramienta como excusa.

· **No se llama «Clientes».** Esto no es un CRM —eso es F6— sino la lista de con
quién se puede hablar y con qué permiso. Llamarlo Clientes prometería algo que no
está.

### Y un rango de fechas que se iba a la víspera

La pantalla de rentabilidad pasaba `?from=2026-08-11&to=2026-08-11` y la tabla
salía **vacía**. El endpoint convertía esas fechas con `new Date`, que las
interpreta como medianoche **UTC** — las 19:00 del día anterior en Lima. El
informe respondía por la víspera mientras enseñaba las fechas pedidas: un margen
que no cuadra con las ventas del día y **ningún error a la vista**.

La conciliación ya trataba `?date=` como un DÍA por este mismo motivo, con el
razonamiento escrito al lado; a rentabilidad le faltaba. Ahora acepta fechas de
negocio `AAAA-MM-DD` tal cual, con su prueba de regresión.

Van tres fallos en dos sesiones que **solo aparecen cuando hay datos de verdad**
(el buscador de pedidos, el «Ventas» de la portada, y este). Sembrar datos
realistas y comprobar el resultado —no la mera presencia— es lo que los saca.

## La tienda como producto, y no como plantilla

El propietario pidió que la carta y el carrito «se puedan usar de verdad», que
haya oferta de bienvenida, que el cliente pueda montar **su** web contra nuestra
API, que la tienda se vea con su marca y que se pueda pagar con Apple Pay o
Google Pay. Eso se hizo en cinco tandas —tienda rehecha, promociones, ADR-0020
con clave publicable y CORS, aspecto por marca, medios de pago— y las tres
últimas comparten el mismo hallazgo, repetido:

**había API y no había quien la llamara.**

- `POST /payments/connections` existía desde F5 sin ninguna pantalla: la única
  forma de conectar una pasarela era un `curl`. Ahora está en `/panel/pagos`, y
  se añadió el `GET` que faltaba — sin él la conexión era de un solo uso, porque
  el token del webhook se devuelve UNA vez y quien cerrara la pantalla sin
  copiarlo perdía la URL de confirmación de cobros. Eso se manifiesta como «los
  pedidos se quedan en pendiente», sin ninguna pista.
- El checkout aceptaba `payment` desde que existe el módulo de pagos y **la
  tienda nunca se lo mandaba**: todo pedido salía como contra entrega, incluso
  en un negocio con pasarela conectada.
- `POST /delivery/shipments/:id/tracking-link` emitía desde T5.16 un token que
  ninguna pantalla componía y ninguna página sabía abrir. El enlace que se le
  daba al cliente era una URL rota.

Ninguno de los tres lo detecta una prueba de API: en los tres casos la API
contesta perfectamente. Lo que fallaba era que nadie preguntaba.

### Las carteras no son una pasarela

Apple Pay y Google Pay no cobran: entregan un token de red que **la pasarela**
desencripta. Por eso el checkout no las implementa — declara qué medios acepta
el negocio (columna `methods` de `pay_connections`) y manda al comprador a la
página de Culqi, que es quien pinta esos botones. De paso, ni un dato de tarjeta
pasa por nuestro servidor.

Lo que sí es nuestro es **no anunciar lo que no va a estar**: Apple Pay solo se
enseña si `ApplePaySession.canMakePayments()` lo confirma y Google Pay si existe
`PaymentRequest`. Es necesario y no suficiente —la palabra final la tiene la
pasarela—, pero elimina el caso que ocurriría el 100 % de las veces: Apple Pay
ofrecido en el Chrome de un Android. Es la única parte de cliente del checkout,
porque en el servidor no hay navegador al que preguntar.

Apple exige además su archivo de verificación en `/.well-known/` de **cada
dominio**. En un SaaS multimarca eso no es un archivo: es uno por cliente, y lo
sirve el mismo proceso que resuelve por host. Sin él el botón no aparece y no
hay ningún error que lo explique.

### Lo que sigue faltando aquí

El adaptador HTTP real de Culqi. Hoy la pasarela es el simulador de F5, que
devuelve una URL de sandbox que no resuelve; para conectarlo hacen falta
credenciales `pk_test_`/`sk_test_` del propietario. El camino entero —elegir
medio, crear la intención, salir a la pasarela, volver por webhook firmado— está
construido y probado contra el simulador: lo que falta es la llamada real.

**Próxima acción de Claude Code:** ya no queda nada bloqueante en `specs/ux/03` — lo que resta (Clientes, Novedades, y el resto de Configuración) es consulta secundaria que no impide operar. El cuello de botella real sigue siendo **DT-02**: sin entorno cloud no hay pilotos, y sin pilotos con un mes de venta no se abre F6. Si aparecen las credenciales, lo siguiente es el Terraform.

---

## Railway: el despliegue gestionado, y el fallo que había que evitar

DT-02 deja de estar bloqueada: el proveedor es **Railway**. El despliegue está
descrito como código en `infra/railway/{api,worker,web}.json` y el
procedimiento en `docs/35-railway.md`.

Lo primero al saber el destino no fue configurar servicios, sino esto: **un
Postgres gestionado entrega una sola `DATABASE_URL`, y es la del administrador.**
Pegarla en la variable de la aplicación es el camino corto, evidente, y el que
sugiere el propio panel del proveedor. También es el peor fallo que este sistema
puede tener, porque un rol superusuario —o con `BYPASSRLS`— hace que Postgres
**ignore la Row Level Security entera**. Las consultas responden, las pruebas
pasan, los pedidos entran, y cada cliente ve los datos de todos los demás. Sin
excepción, sin log, sin síntoma.

Se ataca por los dos lados:

- `bootstrap-roles.ts` prepara la base con el rol administrador: instala
  pgvector, crea `sahana_migrator` (dueño del esquema) y `sahana_app` con
  `NOSUPERUSER NOCREATEROLE NOBYPASSRLS` explícitos, y devuelve las dos URLs
  correctas por stdout.
- `preflight.ts` corre al arrancar la API y el worker, y **el proceso no
  arranca** si el rol de conexión puede saltarse RLS. Fallar ruidosamente al
  desplegar es incomparablemente mejor que servir dos meses con los datos
  mezclados.

Ensayo completo contra una base **vacía**, que es lo que será Railway el primer
día: arranque de roles → **31 migraciones** → re-arranque idempotente. Falló a
la primera, y por algo que solo aparece en una base recién creada: `CREATE
EXTENSION` exige superusuario, el migrador no lo es a propósito, y la migración
0028 se paraba pidiendo pgvector. Ahora lo instala el arranque, con el rol que
sí puede, en el **primer** comando del despliegue — enterarse ahí es media hora
menos que enterarse con veintisiete tablas ya creadas.

### Dos cosas que el ensayo destapó y no se habrían visto de otra forma

**El arranque desactivaba el append-only al repetirse.** Concede DML sobre todas
las tablas —hace falta para el caso «la base ya estaba migrada»— y ese permiso
masivo volvía a conceder justo lo que cada migración revoca. Yo había revocado
dos tablas a mano; son **ocho**. Re-ejecutar el arranque en un despliegue
cualquiera habría dejado el histórico de auditoría editable, en silencio. Ahora
la lista vive en `append-only.ts` y una prueba la compara con los `REVOKE`
reales de `infra/migrations/`: si alguien añade una tabla append-only y no la
añade a la lista, la prueba falla. Comprobado quitando una a propósito.

**La sonda de salud de la tienda habría impedido el despliegue.** La tienda
deduce la marca del `Host` del visitante, y la sonda de Railway llega con el
host interno del proveedor. Medido: `GET /` sin una tienda para ese host
devuelve **500**, así que el servicio nunca habría entrado en servicio y el
síntoma habría sido «Railway no despliega». Ahora hay `/api/salud`, que no
depende del `Host` y responde 200 aunque la API no conteste —informando de su
estado en el cuerpo—: si la tienda se declarara enferma cada vez que la API se
reinicia, un despliegue normal de la API tiraría también la tienda.

Las migraciones van en el `preDeployCommand` del servicio `api`, con
`sync-roles` detrás. Railway lo ejecuta antes de poner la versión nueva en
servicio y, si falla, **no la pone**: la anterior sigue atendiendo. Es lo que ya
conseguía el servicio `migrate` del compose, por el mismo motivo.

**Próxima acción de Claude Code:** el despliegue está listo para ejecutarse y lo
que falta son las credenciales de la cuenta de Railway. Con ellas: crear el
Postgres **con pgvector**, correr `bootstrap:roles`, configurar las variables de
§4 y desplegar `api` antes que `worker`. Detrás vienen las tres cosas que
esperaban a DT-02 y ahora sí tienen dónde correr: medición de carga real
(DT-05), pentest (T5.36) y los pilotos.

---

## La carta desde un Excel

De los seis hallazgos del contraste con el documento maestro (docs/36), este era
el único que no dependía de una decisión de producto: dar de alta un cliente
pasaba por escribir su carta en JSON, y un dueño con 180 productos los tiene en
una hoja de cálculo. Escribirlos a mano es una tarde por cliente.

`import-csv.js` los lee de un CSV. La decisión de diseño que lo gobierna es que
**no toca la base de datos**: produce el mismo `negocio.json` que ya aplica
`setup-business.js`. Tres motivos, en orden de peso:

- No duplica ninguna regla. Un segundo camino de escritura al catálogo sería un
  segundo sitio donde los precios pueden salir distintos.
- Se puede revisar antes de aplicar. Importar la carta que hizo otra persona y
  publicarla sin mirarla es cómo se vende un pollo con un cero de menos.
- Se prueba entero sin base de datos, así que las pruebas son baratas y de
  verdad.

Las hojas de `infra/ejemplos/` **reproducen exactamente `negocio.ejemplo.json`**,
y una prueba lo comprueba. Eso es lo que hace fuerte el conjunto: ese JSON ya se
aplica en CI de punta a punta —monta el negocio, pide un pedido, comprueba que
cobra el precio del archivo y que el kardex descuenta lo que dice la receta— así
que el camino del CSV hereda esa verificación entera en vez de tener una propia
y más floja. Además hay un caso e2e nuevo que aplica la carta importada contra
Postgres real y comprueba que cobra los 59,00 de la columna `precio_web`.

### Lo que se comprueba no es «lee un CSV»

Es leerlo **mal sin dar error**, que es lo único que puede pasar aquí de forma
cara:

- **Excel en español exporta con `;` y coma decimal.** Es el caso normal, no el
  raro. Con el separador equivocado el archivo entero se lee como una columna.
- **Un SKU repetido es un error**, no gana el último: en una hoja de 180 líneas,
  quedarse con el último hace desaparecer un producto sin que nadie lo note.
- **Los importes distinguen miles de decimales por cuál va al final**, así
  `1.500,00` y `1,500.00` dan lo mismo sin preguntar el idioma. Y nunca pasan
  por coma flotante: entran y salen como cadena.
- **Un combo sin componentes se rechaza**; la cantidad es explícita (`x1`),
  porque dar por hecho «uno» convierte un combo de dos pollos en uno de uno.
- **Un grupo de modificadores mal escrito falla antes de aplicar**, en vez de
  publicar el plato sin sus extras.

Las dos comprobaciones que más importan se verificaron **mutando el código** para
confirmar que fallan por lo que dicen cubrir. Y de paso apareció una prueba que
pasaba por el motivo equivocado: la del BOM. Resulta que `trim()` ya elimina
U+FEFF —está en el conjunto de espacios en blanco de JavaScript—, así que los dos
`replace` del BOM que había escrito eran código muerto. Se quitaron y se explicó
el mecanismo real donde toca.

**Próxima acción de Claude Code:** conectar Culqi de verdad en cuanto el
propietario pase sus credenciales de sandbox, y hacer que el enlace de
seguimiento salga solo por WhatsApp al recoger el pedido (la plantilla existe;
hoy hay que pegarlo a mano). Siguen pendientes de decisión del propietario
**PA-09** (pagos mixtos), **PA-10** (salón y QR) y **PA-11** (stock reservado),
y dependen de F6 la liquidación de propinas y el P&L con gastos.

---

## Fotos en la carta (2026-08-22)

**El mismo patrón, por sexta vez: un campo que existe en todas partes menos donde
se usa.** `image_url` está en la tabla desde la migración 0008, el upsert de
catálogo lo escribe, la tienda lo pinta en la cuadrícula de platos y en la ficha
del producto — y el panel no tenía **ningún sitio** donde ponerlo. La única forma
de que un plato tuviera foto era subir la carta entera por archivo o escribir
SQL a mano. Una carta sin fotos vende bastante menos, y el dueño no tenía cómo
arreglarlo.

**Por qué un endpoint aparte y no un campo más del formulario.** `POST
/catalog/products` es un upsert que **reescribe todas las columnas**:
`description = $6`, `image_url = $7`, `allergens = $8::jsonb`. La lista que
consume el panel no devuelve ni la descripción ni los alérgenos, así que
reenviar el producto desde esa pantalla para cambiarle la foto habría dejado los
dos campos en blanco, en silencio y sin un solo error a la vista. **Un producto
que pierde sus alérgenos es un problema de salud, no de datos.** De ahí
`POST /catalog/products/:id/image`, estrecho como `pause` y `resume`, con su
prueba de que la descripción y los alérgenos siguen ahí después de tocar la foto.

**Se guarda una dirección, no un archivo.** Subir imágenes pide almacenamiento
de objetos, recorte y límites de tamaño, y nada de eso está decidido. Pegar la
URL de la foto que el dueño ya tiene resuelve el problema hoy sin comprometer a
medias una arquitectura de archivos.

**Solo `https`.** Una foto servida por `http` hace que el navegador marque la
tienda entera como insegura, o bloquee la imagen y deje el hueco. El dueño vería
su tienda «rota» a una pantalla de distancia de la causa, así que el «no» se da
al pegarla, con el motivo escrito.

### Dos hallazgos de las pruebas de navegador

· **Localizar por posición caduca.** Las dos pruebas de precio hacían
  `getByRole('button', {name:'Guardar'}).nth(1)`, dando por hecho que «Tienda
  web» sería siempre la segunda columna. Añadir la columna de foto las rompió.
  Ahora cada botón de guardar lleva su nombre accesible —`Guardar el precio de
  web`— y las pruebas van por nombre. Es además lo correcto de accesibilidad:
  cuatro botones «Guardar» seguidos en la misma fila no se distinguen con un
  lector de pantalla.
· **En Playwright, buscar por nombre es por SUBCADENA.** El primer intento llamó
  al botón `Guardar precio en web`, que contiene la etiqueta del campo —`Precio
  en web`— y hacía que `getByLabel` encontrara los dos. El nombre de un control
  no puede contener el de su vecino.

Verde: **751 API · 447 dominio · 25 web · 23 POS · 49 navegador**, sin
violaciones de frontera (463 módulos).

**Próxima acción de Claude Code:** los tres componentes que `docs/25` da por
obligatorios y no existen en ninguna pantalla — estado vacío con acción, aviso
con deshacer de 8 s, y confirmación destructiva que exige motivo escrito.

---

## Los tres componentes que docs/25 daba por obligatorios (2026-08-22)

Estaban en la spec desde el principio y no existían en ninguna pantalla.

**1. Estado vacío con acción** (`vacio.tsx`). El panel tenía unos treinta
`<p class="panel__vacio">` con una frase suelta. La frase estaba bien escrita;
el problema es que **un panel recién abierto es casi todo estados vacíos**, y
treinta callejones sin salida seguidos hacen cerrar la pestaña. La distinción
que decide si esto ayuda o estorba: «aún no tienes platos» es trabajo pendiente
y lleva botón; **«nadie debe efectivo» es que todo está en orden y no lo lleva**
—ponerle uno inventaría trabajo donde no lo hay—. Por eso `accion` es opcional
y omitirla es una decisión, con su variante visual `enOrden`.

**2. Aviso con deshacer de 8 s** (`aviso.tsx` + `aviso-reglas.ts`). Cambiar un
precio se hace veinte veces seguidas cuando sube el pollo; pedir «¿seguro?» en
cada una entrena a pulsar «sí» sin leer y a la vigésima ya no protege de nada.
Tres decisiones que no son evidentes:

· **El error NO caduca**, solo el «hecho». Un aviso de error que desaparece a
  los ocho segundos deja al operador creyendo que guardó cuando no guardó — en
  una carta, eso es cobrar el precio viejo toda la tarde.
· **Deshacer es una acción de servidor**, no un `setState`. Lo revertido ya está
  en la base y puede que ya lo viera un cliente.
· **Lo deshecho no se vuelve a deshacer.** El formulario manda `esDeshacer=1` y
  la acción omite entonces su propio `deshacer`. Sin eso quedan dos avisos que
  se revierten mutuamente y nadie sabe en qué precio quedó el plato.

Las reglas viven en un archivo aparte **con pruebas** porque son lo único que
puede estar mal sin verse: en el instante cero, un aviso que caduca a los ocho
segundos y uno que no caduca nunca son idénticos. No se añadió `jsdom` ni
`@testing-library`: `vitest.config.ts` de `apps/web` ya explica por qué los
componentes se prueban en el navegador y no con un renderizador falso.

**3. Confirmación destructiva con motivo escrito** (`confirmar.tsx`), en la
anulación de comprobantes — **la única acción irreversible del panel**: la nota
de crédito se declara al OSE y de ahí no vuelve. El botón que ejecuta está
apagado hasta que hay motivo; si estuviera activo, esto y un «¿seguro?» serían
lo mismo. Sin JavaScript se pinta el formulario en línea de siempre, que ya
exigía el motivo en el servidor: se pierde el diálogo, no la protección.

El reparto entre los dos últimos es deliberado: **reversible → deshacer,
irreversible → confirmar**. Usar el mismo para todo es lo que convierte los
diálogos en ruido.

Aplicado a la carta (precios, pausas y fotos), a la portada, a la torre de
control, a reparto y a pedidos. Los vacíos que quedan con la prosa de antes son
resultados de filtro neutros, sin más acción que cambiar el filtro.

Verde: **751 API · 447 dominio · 35 web · 23 POS · 53 navegador**.

---

## Rentabilidad: el total, el peso de cada fila y el archivo del contador (2026-08-22)

La tabla contestaba «¿cuál gana dinero?» pero **no «cuánto ganamos»**, que es la
primera pregunta de cualquiera que la abre. Nueve columnas de cifras sin una
línea de total.

**El total se calcula en `@sahana/domain`**, no en el `page.tsx`. Es literal en
CLAUDE.md —«cálculo de totales SOLO en @sahana/domain»— y aquí se nota: la forma
corta era un `reduce` con `Number(...)` sobre las cadenas decimales, que mete
coma flotante justo en la cifra con la que un dueño decide si cierra una marca.
`totalizarRentabilidad` suma con `Money`, en enteros, y la usan **la pantalla y
el CSV**, que es lo que garantiza que el archivo y la tabla digan lo mismo.

Dos columnas **no se suman, se recalculan**, y ese es el fallo que las pruebas
impiden:

· **El porcentaje de margen.** Promediar los porcentajes de fila da un número
  *plausible* y falso: una marca con dos pedidos al 60 % pesaría igual que otra
  con doscientos al 5 %, y saldría 32,5 % donde lo cierto es 5,54 %.
· **El ticket promedio**, por lo mismo: neto total entre pedidos totales, no la
  media de las medias.

También: tres tarjetas con las cifras del periodo antes de la tabla, una **barra
de peso** por fila —leer nueve columnas no dice cuál pesa; el porcentaje va en
el `title` para quien no ve la barra, que es la misma regla que no dar
información solo por color— y **exportar CSV con la fila de TOTAL dentro**.
Dejarla fuera obliga a sumar en Excel una columna cuyo total ya estaba bien
calculado, y una suma hecha dos veces es una suma que va a discrepar. Sin
periodo el export devuelve 400 y no un archivo vacío: un CSV de cero filas
parece un periodo sin ventas.

### Tres trampas de localizador, todas del mismo tipo

Las pruebas de navegador fallaron tres veces seguidas por **coincidencia por
subcadena**, que es el comportamiento por defecto de Playwright y no se parece
a lo que uno escribe:

· `td.dinero:nth-of-type(1)` significa «el primer `td`, que además sea
  `.dinero`» — la celda de la marca, que no lo es. `nth-of-type` cuenta por
  etiqueta, no por clase.
· `hasText: 'Venta neta'` **no distingue mayúsculas** y casaba también la
  tarjeta del margen, cuyo pie dice «… de la venta neta».
· Y la de antes: el nombre accesible de un botón no puede contener el de su
  campo vecino.

Verde: **751 API · 457 dominio · 35 web · 23 POS · 55 navegador**, 471 módulos
sin violaciones de frontera.

---

## Chips y export en los listados que faltaban (2026-08-22)

`specs/ux/03` lo pide para **todo listado** —«filtros por chips, export CSV,
columnas de dinero alineadas derecha»— y solo lo tenía pedidos.

**Histórico.** El filtro era un `<select>` con un botón «Filtrar». Ahora son
chips con **la cuenta dentro**, y esa es la diferencia real: la pregunta que
trae a alguien a la auditoría es «¿hubo descuadres?», y con un desplegable hay
que abrirlo para descubrir que no hubo ninguno. Los atajos que ya existían
—precios, descuentos aprobados, descuadres— siguen primero; el resto va por
volumen, y **solo aparece lo que tiene algo detrás**: ofrecer un filtro que
devuelve cero hace dudar de si falla el filtro o si eso no pasó nunca, que son
dos conclusiones muy distintas.

Su CSV lleva el **motivo escrito** de cada línea. Es media razón de que exista
el histórico: «anulado» no explica nada y «RUC mal digitado» se explica solo.

**Comprobantes.** El export trae **los cuatro estados en un archivo**, no solo
los aceptados. Un comprobante rechazado o encolado es una venta *sin declarar*:
un archivo que solo trajera los buenos enseñaría un mes que cuadra mientras las
ventas que faltan quedan fuera del archivo y fuera de la vista. Cada fila lleva
su estado y el código y motivo del rechazo.

**Inventario.** Chip «Bajo mínimo» con su cuenta — es la única pregunta que se
le hace de verdad a esa tabla, *qué hay que comprar hoy*, y había que buscarla a
ojo entre las filas en rojo. Y export de existencias con una columna **«Contado»
vacía**: el uso real es imprimirlo, recorrer el almacén anotando lo que hay y
comparar. Sin esa columna el papel no sirve para lo único para lo que se
imprime. Las cantidades salen como cadena decimal tal cual — pasarlas por
`Number` para «limpiarlas» les quitaría decimales significativos (350 g de un
insumo que se mide en kilos es `0.3500`) en un archivo que decide compras.

De paso, los vacíos de esas tres pantallas pasaron a `Vacio`, distinguiendo
«nada rechazado» —buenas noticias— de «ningún plato descuenta stock», que sí es
trabajo pendiente y ahora explica su consecuencia: sin receta el food cost es
cero, así que ese plato aparenta más margen del que tiene.

Verde: **751 API · 457 dominio · 35 web · 23 POS · 58 navegador**, 474 módulos
sin violaciones de frontera.

---

## `packages/ui`: los tokens, y el canal que faltaba en la cocina (2026-08-22)

docs/25 sitúa los tokens en `packages/ui`, «consumidos por las 3 apps web». El
paquete no existía y cada app repetía sus colores: **diecisiete hexadecimales
duplicados** entre `globals.css`, `panel.css` y `estilos.css`. Repetir un color
no rompe nada el día que se escribe; rompe el día que alguien aclara el gris de
los bordes en una sola de las tres y nadie se entera, porque nadie abre las tres
a la vez.

**El caso que lo hizo urgente no era la duplicación, era una ausencia.** El
color por canal —que docs/25 pide «usado consistentemente… el operador aprende a
leer el origen de un vistazo»— estaba escrito solo en el panel, y **el KDS ni
siquiera recibía el canal del pedido**. `TicketView` no lo traía. Así que quien
aprendía «naranja = Rappi» mirando el panel llegaba a la cocina y encontraba
todas las comandas iguales. No es un adorno: un pedido de Rappi tiene un
repartidor esperando en la puerta y uno de la tienda web es un reparto
programado, así que el orden en que se cocinan no es el mismo.

Ahora el canal viaja en el ticket —consultado desde el **pedido**, no duplicado
en la tabla de tickets, que es como los dos empezarían a discrepar— y el KDS lo
pinta con su píldora.

**Lo que el paquete NO tiene: componentes.** Ni un botón. Son tres superficies
con tres usuarios, tres distancias de lectura y tres tamaños de objetivo táctil
—el panel a 60 cm, el POS a 30 con prisa, el KDS a dos metros entre vapor—. Un
`<Boton>` común acabaría con seis variantes y una propiedad `tamano`, que es la
forma larga de no compartir nada. Lo que se comparte es el **vocabulario**: qué
es «error», qué es «Rappi», cuánto es un radio. Cada app conserva sus alias
locales (`--panel-fondo`, `--fondo`) y solo cambia de dónde sale el valor.

Dos detalles que no son evidentes:

· **Las píldoras claras no valen en el KDS.** Sobre gris 10 %, un fondo
  `#dcfce7` deslumbra a dos metros y cansa en un turno de ocho horas — justo lo
  que docs/25 evita al pedir «gris 90 % sobre gris 10 %». En oscuro el color va
  en el borde y el texto, y el fondo se queda oscuro. Y la píldora **crece a
  1 rem**: 0,75 rem se lee a 60 cm y no desde el otro lado de la cocina.
· **Un canal desconocido enseña su identificador crudo.** Inventarle un nombre
  bonito escondería que el sistema no lo reconoce, y ese es justo el pedido que
  hay que mirar.

Se verificó que el `@import` de un paquete del workspace resuelve **en los dos
empaquetadores** —webpack de Next y Vite— y que los tokens acaban en el CSS
emitido, no solo en el fuente.

Verde: **752 API · 457 dominio · 5 ui · 35 web · 23 POS · 58 navegador**, 478
módulos sin violaciones de frontera.

---

## El enlace de seguimiento se manda solo (2026-08-22)

La página de seguimiento estaba construida entera desde T5.16 —token público,
datos mínimos, sin autenticación— y **en la práctica no la recibía casi nadie**:
había que emitir el enlace desde el panel y pegarlo a mano en el chat. Una
promesa hecha y no entregada, que es peor que no haberla hecho.

Ahora el aviso de «tu pedido va en camino» lo lleva dentro. Cuatro decisiones
que no son obvias:

· **Solo al SALIR.** Mandarlo antes enseñaría una página que dice «todavía en
  cocina», y un enlace que no aporta nada la primera vez que se abre es un
  enlace que el cliente ya no vuelve a abrir.
· **Se REUTILIZA el token vivo** (`PublicTokensService.findLive`). Avisar dos
  veces —un reintento, un cambio de repartidor— dejaría dos enlaces distintos
  en el mismo chat, y quien abriera el primero vería un seguimiento que ya nadie
  actualiza.
· **El host preferido es el dominio propio VERIFICADO de la marca**, que el
  cliente reconoce: un enlace a un dominio ajeno en un chat de WhatsApp parece
  una estafa. Solo verificados — uno pendiente todavía no resuelve, así que
  sería un enlace muerto, peor que ninguno. Sin dominio propio se usa
  `PUBLIC_TRACKING_BASE_URL`.
· **Sin envío o sin base, el aviso se manda IGUAL, sin enlace.** Mostrador,
  recojo en tienda, o un marketplace que reparte con su flota. Quedarse sin
  avisar por no tener una URL sería cambiar un problema pequeño por uno grande.

El enlace va **en su propia línea** del texto libre: pegado a la frase, algunos
clientes de WhatsApp se comen el último carácter al detectarlo.

Mensajería depende ahora de Delivery **por su índice público**, que es para lo
que existen los índices: de los envíos sabe Delivery. La única consulta que
cruza módulos por SQL es la del host en `sto_domains`, y está explicada donde
está: hacer que Delivery dependa de Storefront entero por un `SELECT` de una
columna acoplaría dos módulos que por lo demás no se conocen.

### Un fallo mío del commit anterior

`9f3bcba` incluía una prueba con un campo que no existe en `SubmitOrderInput`.
Pasó porque tras escribirla corrí vitest, lint y depcruise **pero no `tsc`** — y
vitest no comprueba tipos ni ESLint es consciente de ellos. Corregido aquí. La
lección es del orden: el typecheck va después del último cambio, no antes.

Verde: **756 API · 457 dominio · 5 ui · 35 web · 23 POS · 58 navegador**.

---

## La checklist de salida en vivo (2026-08-22)

`docs/26` §5 y `specs/ux/03` la piden desde el principio —«checklist persistente
hasta completarse»— y no existía. docs/26 lo dice sin rodeos: **«el churn
temprano de POS se decide en el onboarding, no en las features»**, y la métrica
del proyecto es *alta → primera venta real en menos de un día*. Hasta ahora ese
camino solo existía en un documento: el dueño que entraba por primera vez veía
catorce pantallas vacías y ninguna le decía cuál era la siguiente.

**Se CALCULA, no se guarda.** No hay tabla de progreso, y es la decisión que
sostiene todo lo demás: un estado guardado se desincroniza del mundo — alguien
borra el único usuario con PIN y la checklist sigue diciendo que está hecho, y
el dueño abre el local convencido de algo que ya no es cierto. Seis `EXISTS` en
una sola transacción sobre lo que ya existe. Hay una prueba dedicada a esto:
crea el local, comprueba que el paso se marca, **lo borra**, y comprueba que
vuelve a estar pendiente.

Detalles con motivo:

· **«Comprobante ACEPTADO», no emitido.** Uno rechazado demuestra que la
  conexión con el OSE funciona a medias, que es la peor forma de descubrirlo el
  primer día de venta real.
· **«Carta CON PRECIO».** Un producto sin precio no se vende en ningún canal
  (RN-CAT-01): una carta sin precios es una carta que no existe para el cliente.
· **El opcional no cuenta para el total.** Si la receta contara, un negocio
  listo para abrir vería «6 de 7» y se quedaría buscando qué le falta.
· **Cada paso dice POR QUÉ**, no «paso 3 de 6». «Crea un cajero con su PIN» no
  convence; «sin PIN, un descuadre no tiene a quién preguntarle» sí.
· **Lo pendiente va primero** y lo hecho se atenúa pero **no se tacha**: tachado
  se lee como «cancelado», y estos pasos no se cancelan, se completan.
· **La lista desaparece sola** al completarse, y no se puede cerrar antes — si
  se pudiera, se cerraría el primer día y la primera venta llegaría sin
  comprobante.

### Dos cosas que aprendí por las malas

· **La regla de ESLint que protege el dinero saltó con `total: number`.** Era un
  falso positivo —una cuenta de pasos— pero la respuesta correcta no era
  silenciar la regla: era **renombrar el campo a `obligatorios`**. `total:
  number` es exactamente el error que esa regla existe para impedir, y un nombre
  que obliga a mirar dos veces es un mal nombre.
· **Cuarta vez que muerde la coincidencia por subcadena de Playwright.** El
  enlace nuevo «Manda una comanda a cocina» casaba con el localizador
  `{ name: 'Cocina' }` de la navegación, y rompió una prueba que no tenía nada
  que ver. Ya lleva `exact: true`.

De paso, la checklist dijo algo útil sobre la propia semilla demo: es un negocio
**a medio arrancar** —4 de 6—, sin cajero con PIN ni ninguna comanda terminada
en cocina. La prueba de navegador afirma eso, que es la verdad, en vez de
afirmar lo que me habría gustado que fuera.

Verde: **763 API · 457 dominio · 5 ui · 35 web · 23 POS · 59 navegador**, 484
módulos sin violaciones de frontera.

---

## Pegar la carta desde un Excel, dentro del panel (2026-08-22)

`docs/26` §2 pide el importador **en la pantalla**. Lo que había era un guion de
línea de comandos: transforma un CSV en el `negocio.json` que aplica
`setup-business`. Sirve para dar de alta clientes desde nuestra máquina y no le
sirve de nada al dueño que ya está dentro del panel con su hoja abierta en otra
pestaña — y ese es el caso que decide la métrica de docs/26, porque escribir 180
platos a mano es una tarde.

**El guion tenía razón y por eso no se ignoró.** Su cabecera argumenta por qué
NO escribe en la base: «un segundo camino de escritura al catálogo sería un
segundo sitio donde los precios pueden salir distintos». Se respeta de dos
maneras: se parsea con **su misma función**, así que las reglas del Excel
peruano —`;`, coma decimal, `S/`, y **SKU repetido es error y no “gana el
último”**— y los mensajes que nombran fila y columna son los mismos ya probados;
y se escribe por **`CatalogAdminService`**, el mismo upsert del formulario de un
solo plato. La importación es un lote de esas altas, no una vía paralela.

**Nada se aplica sin que alguien lo mire.** Un solo endpoint con `dryRun`, que
por defecto es **true**: escribir hay que pedirlo. Y el mismo código calcula la
vista previa y aplica — dos rutas distintas acabarían divergiendo y lo aprobado
no sería lo guardado. En la pantalla, el botón de aplicar **no existe** hasta
tener la previa delante: con una casilla de «aplicar de verdad», marcarla por
error publica ciento ochenta precios.

Detalles con motivo:

· **El parseo va primero y entero.** Si la fila 140 tiene un precio imposible,
  no se escribe ninguna de las 139 anteriores: una carta a medio importar es
  peor que ninguna, porque nadie sabe dónde se cortó.
· **La previa normaliza los precios por `Money`.** La hoja trae `32,00` y la
  base guarda `32.0000`; enseñarlos crudos uno al lado del otro se lee como si
  hubieran cambiado cuando no.
· **La comparación «igual/cambia» es por `Money`, no por texto.** `45.90` y
  `45.9000` son el mismo precio, y compararlos como cadenas marcaría toda la
  carta como «cambia» en cada importación — con lo que el diff dejaría de
  significar algo.
· **Queda en el histórico** (`catalog.imported`): es, con diferencia, la acción
  de mayor alcance del panel, y «¿quién subió esta carta?» tiene que tener
  respuesta.

### Un ciclo que apareció al conectar las piezas

Importar el parser desde el módulo de catálogo creó un ciclo real —catálogo →
importador → alta de negocio → tienda → catálogo— que `dependency-cruiser`
rechazó. La causa: el guion depende de `business-setup.ts`, que conoce media
aplicación. Se extrajo el parseo puro a `database/carta-csv.ts`, **sin ninguna
dependencia de módulos**, y el guion ahora lo reutiliza. Las 20 pruebas
existentes del importador pasan sin tocarlas, que es lo que confirma que la
extracción no cambió comportamiento.

Verde: **771 API · 457 dominio · 5 ui · 35 web · 23 POS · 62 navegador**, 489
módulos sin violaciones de frontera.

---

## Modo práctica: equivocarse a propósito, y estrenar limpio (2026-08-23)

`docs/26` §4: «datos demo descartables con un botón "borrar práctica y empezar
en serio" (borra ventas demo, conserva catálogo)». El problema que resuelve es
real y no técnico: un dueño recién dado de alta **necesita equivocarse** —cobrar
mal, anular, cerrar la caja con descuadre, mandar una comanda que no existe—.
Si esas pruebas se quedan mezcladas con las ventas de verdad, el primer informe
de rentabilidad miente y el primer cuadre con SUNAT no cuadra. Y si por miedo a
ensuciar **no** prueba, se estrena el sábado a las ocho de la noche.

**Una marca de tiempo, no un booleano por fila.** La alternativa era
`es_practica` en cada pedido, comprobante y sesión de caja: quince columnas que
hay que acordarse de rellenar en quince sitios, y la que se olvide deja una
venta de práctica contada como real para siempre. Con `went_live_at` en el
tenant la regla es una sola y no se puede olvidar. Al pulsar, se borra y se
estampa la fecha — y **desde ese momento el botón no existe**: no hay forma de
vaciar las ventas de un negocio que ya opera, ni por error ni queriendo.

### La base de datos me dijo que no, y tenía razón

El primer intento falló con `permission denied for table pay_webhook_events`.
Cinco tablas le niegan el `DELETE` al rol de la aplicación **a propósito**:
`bil_submissions`, `cash_movements`, `inv_movements`, `ord_order_events` y
`pay_webhook_events`. La tentación era añadir el permiso en la migración. No se
hizo:

· Tres de ellas —envíos al OSE, movimientos de caja, eventos del pedido— se van
  **en cascada con su padre**, que es la única forma correcta de que
  desaparezcan.
· `inv_movements` e `inv_stock` **se quedan**, y es la decisión incómoda. El
  kardex es append-only y su padre no se borra; vaciar el stock dejaría las
  existencias diciendo una cosa y su libro otra — el descuadre exacto que el
  kardex existe para impedir. La práctica que movió stock se corrige como
  cualquier error de inventario: **con otro movimiento**. Y la pantalla lo dice
  antes de pulsar, porque descubrirlo tres semanas después es mucho peor.

**Los correlativos vuelven a cero**: la primera venta de verdad tiene que ser la
#1 y la B001-1. Dejar el contador donde estaba obligaría a explicarle a SUNAT
dónde están los comprobantes 1 a 40. **La auditoría no se borra** — es
append-only por construcción y es donde queda esta misma acción; un borrado que
borrara su propia huella es justo el que no se puede permitir.

Usa la confirmación destructiva de docs/25 con **consecuencias listadas**, que
es lo que specs/ux/03 pide para las acciones peligrosas.

### Y una prueba que estaba mal escrita

La de aislamiento afirmaba «B está a cero». En cuanto las pruebas de práctica le
dieron estructura a B, empezó a fallar — no por un fallo de aislamiento, sino
porque estaba atada al orden de ejecución. Ahora compara **antes contra
después**, que es lo que de verdad quiere decir «lo de A no toca a B».

Verde: **776 API · 457 dominio · 5 ui · 35 web · 23 POS · 63 navegador**, 491
módulos sin violaciones de frontera.

---

## Novedades: qué puedes hacer ahora que antes no (2026-08-23)

`specs/ux/03` la lista en la estructura del panel y `docs/26` la pide «con
lenguaje de operador, no de developer». Faltaba entera, y sin ella todo lo
construido estas semanas es invisible: el dueño no tiene forma de enterarse de
que ya puede pegar su carta desde Excel.

**Un archivo del repositorio, no una tabla.** No es un dato del negocio —es lo
mismo para todos los clientes— y una tabla obligaría a inventar una pantalla
para escribirlo y un sitio del plano de control donde guardarlo. En el
repositorio viaja **con el código que describe**: se revisa en el mismo cambio
que lo produce y **no puede mentir** — si la línea está en producción, la
función está en producción.

**Y hay una prueba que comprueba el idioma.** Es la parte que más me gusta de
esto: un test recorre las entradas buscando jerga —«endpoint», «API», «CSV»,
«migración», «componente»— y falla si aparece. **Me pilló a mí**: había escrito
«se bajan en CSV», que para un dueño de pollería no significa nada. Ahora dice
«se bajan en un archivo que abre Excel». Sin esa prueba, la sección se degrada a
notas de commit en tres semanas, que es exactamente lo que docs/26 pide evitar.

Cada entrada lleva **dónde se usa**, como enlace. Una novedad que no dice dónde
está obliga a buscarla por el menú, y a la tercera nadie las lee.

### El aviso de «sin leer»

Un punto con el número dentro en la navegación, con la fecha de la última visita
en `localStorage`. Tres decisiones:

· **Sin nada guardado no hay aviso.** Quien entra por primera vez ya tiene la
  portada llena de cosas que aprender; recibirlo con «9 novedades» de funciones
  que nunca ha echado de menos es ruido — y el ruido del primer día es el que
  enseña a ignorar el aviso para siempre.
· **Se marca al ABRIR, no al salir.** «Salir» no siempre ocurre: se cierra la
  pestaña, se apaga la tablet. Un aviso que no se apaga nunca enseña lo mismo.
· **Una fecha guardada ilegible se trata como si no hubiera nada.**
  `localStorage` lo puede tocar cualquiera, y un valor roto no debe convertirse
  en un aviso permanente que no se puede quitar.

Todo acceso a `localStorage` va dentro de `try`: lanza en pestaña privada y con
las cookies de sitio bloqueadas, y no poder recordar una visita no puede tumbar
la navegación entera.

Verde: **776 API · 457 dominio · 5 ui · 45 web · 23 POS · 64 navegador**, 496
módulos sin violaciones de frontera.

---

## Clientes: perfil unificado e historial (2026-08-23)

`specs/ux/03` lista «Clientes» en la estructura del panel y era **el último
hueco de esa lista**. `spec 14` sitúa el perfil y el historial en **F5** —la
fase actual—; las campañas quedan para F8. Sin esta pantalla, la pregunta más
común de un dueño —«¿este señor cuánto nos compra?»— solo se contestaba buscando
su teléfono en el listado de pedidos, una página cada vez.

**El cliente NO es una tabla.** No hay `crm_customers` y es deliberado: se
**deriva de sus pedidos**, agrupados por teléfono. Una tabla propia habría que
mantenerla sincronizada en cada alta, cada corrección de teléfono y cada pedido
de marketplace que llega con el nombre escrito de otra forma — y el día que se
desincronice, el panel dirá que alguien compró tres veces cuando compró cinco.
Derivarlo cuesta una consulta agregada y **no puede mentir**. Tampoco hizo falta
migración.

**Unificado por teléfono**, que es la única clave que el cliente escribe igual
en los cinco canales. El nombre no sirve: el mismo señor es «Juan Perez» en la
web, «juan» en WhatsApp y «Juan Pérez Q.» en Rappi. Se enseña el más reciente,
que es el que él mismo escribió la última vez.

**El gasto cuenta solo lo entregado.** Sumar los cancelados pondría arriba de la
lista justo al cliente que más cancela — al que NO hay que mandarle una
promoción. Hay una prueba con un cancelado de S/ 999 que lo fija.

### RN-CRM-02: anonimizar sin romper la contabilidad

> se desvincula PII, queda el registro comercial.

Es la regla entera y la parte que más importa hacer bien: **los pedidos no se
borran**. Un pedido es un registro contable con cinco años de retención fiscal
(docs/14), así que borrarlo para atender una solicitud de la Ley 29733 cambiaría
un problema legal por otro peor. Se va lo que identifica —nombre, teléfono,
dirección de entrega— y también el contacto de WhatsApp, porque dejarlo haría
que la anonimización fuera mentira. El importe, la fecha y el canal se quedan, y
el cuadre con SUNAT sigue cuadrando.

**En el histórico NO se escribe el teléfono.** Sería dejar el dato personal en
la única tabla que no se puede borrar; queda cuántos pedidos y por qué, que es
lo que hay que poder demostrar. Una prueba lo comprueba mirando que el número no
aparezca en `audit_log`.

`crm.anonymize` es un permiso **aparte** de `crm.read`: quien consulta el
teléfono de un cliente no es necesariamente quien puede borrarlo para siempre.
El supervisor lee; anonimizar queda en propietario y administrador.

La pantalla usa la confirmación destructiva de docs/25, y la advertencia dice
**las dos mitades**: lo que se borra y lo que se queda. Sin la segunda, quien
tiene que atender la solicitud duda de si va a romper su contabilidad y no la
atiende.

### Y la regla del dinero saltó otra vez, con razón

En una prueba, no en el código de producción: `total: number` en el objeto de un
ayudante. Es donde se cuela la costumbre, así que pasó a cadena decimal como en
la base — igual que hizo falta renombrar `total` a `obligatorios` en la
checklist. La regla lleva tres aciertos.

Verde: **787 API · 457 dominio · 5 ui · 45 web · 23 POS · 66 navegador**, 505
módulos sin violaciones de frontera.

## El presupuesto de JavaScript llevaba meses en verde sin medir nada

Al ir a comprobar la mitad automatizable de **T5.14** —el criterio dice «JS < 200
KB en el catálogo»— apareció que `check-budget.mjs` daba **el mismo número exacto
para las tres rutas**: 99,8 KB y 6 trozos en catálogo, carrito y checkout. Tres
páginas distintas no pesan lo mismo hasta el byte.

La causa: en el App Router las claves del manifiesto llevan el **grupo de rutas**,
que es un directorio entre paréntesis que no aparece en la URL. La tienda vive en
`app/(tienda)/`, así que la clave real es `/(tienda)/carrito/page` y el guion
buscaba `/carrito/page`. **Ninguna búsqueda encontraba nada nunca**, y como el
total arrancaba con los trozos comunes de la aplicación, salía un número
plausible en vez de un cero que hubiera cantado. El presupuesto sumaba lo que
comparten todas las páginas y **cero de lo propio de cada una**, que es
justamente lo único que puede engordar.

Es la peor forma de fallo de un control: **el verde se lee como permiso**. Nadie
mira dos veces un gate que pasa. Alguien podía haber metido una librería de
gráficos en el catálogo y el presupuesto habría seguido diciendo 99,8 KB.

Arreglado normalizando la clave —se quitan los segmentos entre paréntesis— y
sumando además **todos los layouts que envuelven la página**, porque sin el
layout no se pinta nada y no contarlo daría un número que ningún navegador llega
a ver. Los valores reales: **catálogo 104,6 · ficha 107,5 · carrito 105,3 ·
checkout 105,6**, de 200. La cifra que este documento venía citando (105 KB) era
correcta, porque salía de la tabla de `next build`; lo que no existía era **quien
la vigilara**.

**El arreglo trae su propio detector.** Si una ruta del presupuesto no aparece en
la compilación, ahora **falla** en vez de pasar: con el código anterior no
aparecía ninguna, así que esta comprobación habría cantado el fallo el primer
día. Un presupuesto que no encuentra su página no está aprobando, está mirando a
otro lado.

Se añadió también la **ficha de plato**, que faltaba: es la segunda pantalla más
visitada de la tienda y la que más piezas nuevas recibe. Y el mensaje final
distingue los dos casos, que no son el mismo: «se ha superado» cuando pesa de
más, «ha dejado de poder medirse» cuando la ruta ya no encaja. Decir «superado»
sobre un presupuesto que no midió nada manda a optimizar una página que está
bien.

## Y tirando de ese hilo: CI llevaba 28 ejecuciones seguidas en rojo

Comprobar el presupuesto llevó a mirar los demás gates, y de ahí a mirar el
propio CI. **Las 28 últimas ejecuciones habían fallado, sin una sola verde.**
Cinco de los siete trabajos caían, y como `Build` depende de `static` y
`domain`, el presupuesto de la sección anterior ni siquiera llegaba a
ejecutarse: estaba arreglando un gate que no corría.

Cuatro causas, ninguna relacionada con el código de negocio:

**1 · Los paquetes compartidos no se compilaban antes de necesitarlos.** Dos
trabajos distintos por el mismo motivo. `@sahana/domain` se resuelve por el
`dist/*.d.ts` que declara su `package.json`, así que sin compilar no existe: el
typecheck del POS moría con `Cannot find module '@sahana/domain'` —que parece
un import roto y es un paquete sin construir— y la semilla del trabajo de
navegador moría **en un segundo** por lo mismo, antes de tocar la base. Ambos
llevan ya su paso de construcción previo.

**2 · Al trabajo de integración le faltaba pgvector.** `CREATE EXTENSION` es
cosa de un superusuario, no del migrador, y por eso es un paso de
infraestructura. El trabajo de navegador lo tenía; el de integración no. Cada
ejecución moría en `0028_ai_platform.sql` al llegar a la primera columna
`vector`, y con las migraciones caídas **las 787 pruebas de la API y todos los
gates de aislamiento quedaban en «omitido»**.

**3 · El gate de dinero estaba en rojo, y tenía razón.** 100 % de ramas en
`pricing/` es el gate más estricto del proyecto y fallaba por dos líneas de
`modifiers.ts`: las variantes **en singular** de dos mensajes que lee un
cliente. Al reescribirlos para que sonaran a persona se creó una bifurcación
singular/plural y solo se probó la plural. La ironía es que la singular es la
que más se ve: el grupo típico de una carta —el tamaño de un plato— es
justamente `min 1 / max 1`. Ahora se comprueba el texto entero, porque el fallo
que importa no es que no valide, es que valide y enseñe «Elige al menos 1
opciones».

**4 · Una vulnerabilidad alta nueva**, `nanoid < 3.3.18`, heredada por
`vite > postcss` en el POS. Saldada con `override`, como las anteriores.

### Lo que esto enseña, que es más importante que los cuatro arreglos

**Verde en local no es verde en CI, y la diferencia no es aleatoria: es que la
máquina de desarrollo acumula estado.** Aquí el `dist` de los paquetes estaba
construido de antes, y la base de datos tenía las migraciones de antes. Las dos
cosas que fallaban en CI eran exactamente las dos que en local venían dadas.
Reproducirlo requirió una base **recién creada** y quitar el `dist` a mano; con
la máquina tal cual, los cuatro fallos eran invisibles.

Y hay algo peor que las cuatro causas: **nadie miró.** Este mismo documento dice
—dos veces, sobre el gate de formato y sobre el de SCA— que «un gate que lleva
días en rojo deja de leerse, y entonces deja de proteger». Volvió a pasar, y
esta vez con el pipeline entero. Cada commit se dio por bueno con las pruebas
corridas a mano en local, que es precisamente el hábito que un CI existe para
sustituir.

## El enlace de seguimiento nunca salía del dominio del cliente

Con el pipeline ya casi verde, el trabajo de integración llegó por fin a
ejecutar las 787 pruebas —llevaba semanas sin hacerlo— y dos fallaron. Eran las
del enlace de seguimiento por WhatsApp, y pasaban en esta máquina.

La diferencia era una **variable de entorno**: `PUBLIC_TRACKING_BASE_URL`, que
aquí estaba puesta y en CI no. Es el mismo patrón de la sección anterior —el
entorno de desarrollo acumula estado y tapa el fallo— pero esta vez lo que
tapaba era peor que una prueba frágil.

`hostDeSeguimiento` busca el dominio propio del cliente y, si no hay, tira de esa
variable como respaldo. La consulta del dominio propio filtraba por
`status = 'verified'`, y **ese valor no existe**: la restricción de la tabla solo
admite `pending`, `active` y `disabled`, y `verifyDomain` marca `active`. Es
decir, la consulta no encontraba nunca nada y **el dominio del cliente no se
usaba jamás**. Todo salía por el respaldo.

En producción eso significa dos cosas, las dos malas: si la variable no está
puesta —y en el despliegue actual no lo está— el aviso sale **sin enlace**; y si
está puesta, el cliente recibe un enlace del dominio genérico en vez del de la
tienda a la que compró.

**La prueba tampoco ayudaba, y por una razón que conviene recordar:** comprobaba
que el texto contuviera `/seguimiento/`. Eso lo cumple igual el respaldo, así
que daba por bueno el camino equivocado. Ahora se siembra un dominio propio
verificado y se comprueba el enlace **entero, con su host**; se verificó que la
prueba falla si se devuelve el error a su sitio.

La lección se repite en tres capas el mismo día: **un gate que no mira lo que
dice mirar es peor que no tenerlo.** El presupuesto medía trozos comunes en vez
de rutas, esta prueba medía una subcadena en vez de un host, y el CI entero
llevaba 28 ejecuciones sin que nadie leyera el rojo.

### Confirmado: ejecución 130 en verde, los siete trabajos

No es una comprobación local: es la ejecución real de GitHub Actions sobre
`8bab5f5`. **Lint · Types · Boundaries, Domain, Integration, Browser, Build,
Imágenes y SCA, todos correctos.** La primera verde en 30 ejecuciones.

Dentro van, ahora sí ejecutándose de verdad: las **787 pruebas de la API** con
sus gates de aislamiento, las **66 de navegador**, la cobertura de dinero al
100 % de ramas, el presupuesto de JS midiendo las rutas de la tienda y **las
tres imágenes** —API, tienda y POS—, esta última construida aquí por primera
vez.

Hizo falta un ciclo de más porque el primer arreglo no estaba completo: la causa
de los paquetes sin compilar aparecía en un tercer trabajo, y al desbloquear el
de tipos salió a la luz la imagen de la tienda, que llevaba rota desde que
`@sahana/ui` entró como dependencia y **nadie lo veía porque el trabajo se
omitía**. Un rojo tapaba al otro; hasta que el primero no se arregla, no se sabe
cuántos hay debajo.

## Ayuda: pedir soporte por WhatsApp sin explicar quién eres

Primera de las cuatro piezas de **docs/26 «Soporte como producto»** que faltaba
entera. Por WhatsApp a propósito: es el mismo canal que le vendemos al cliente
para atender a los suyos, y si no nos sirve a nosotros, mal se lo estamos
vendiendo. El botón vive en Configuración → Ayuda.

Adjunta **negocio, local, cliente, versión y fecha**, que es la media hora que
se pierde en toda incidencia preguntando «¿qué negocio eres?, ¿qué local?, ¿qué
versión tienes?».

**La confirmación es la parte que no se podía saltar.** La spec dice «previa
confirmación del usuario» y eso se cumple de una sola manera: enseñando el
mensaje **entero, tal cual sale**, con una casilla que lo quita. Un adjunto
automático e invisible es una fuga con buena intención. La prueba de navegador
comprueba justo eso —que al desmarcar, los datos desaparecen del texto— porque
si la casilla fuera decorativa nadie lo notaría mirando la pantalla.

**Lo que NUNCA se adjunta:** ni un dato de los clientes del cliente. Ni
teléfono, ni dirección, ni nombre, ni el contenido de un pedido. Un canal de
soporte es una puerta hacia fuera del sistema, y el día que alguien pida ayuda
con «el pedido de la señora que llamó» no debe irse con él la ficha de la
señora. Está escrito en el módulo y hay una prueba por cada rama.

El texto se compone en un módulo **puro** y aparte de la pantalla: aquí se
decide qué sale del sistema, y eso merece pruebas propias en vez de comprobarse
mirando un WhatsApp.

**Sin número configurado no hay botón que engañe.** `enlaceDeWhatsApp` devuelve
`null` en vez de un enlace sin destinatario, y la pantalla ofrece copiar el
mensaje. Un botón que abre WhatsApp vacío hace creer que el mensaje salió, y el
operador espera respuesta a algo que nadie recibió. Se configuran
`SAHANA_SUPPORT_WHATSAPP` y `SAHANA_VERSION` (docs/34).

**Y lo que no se pudo entregar se anotó en vez de fingirse.** La spec pide
adjuntar «los últimos errores» y ese registro no existe: la API manda un
`traceId` en cada error, pero el panel lo descarta al leer el problema. Hay un
campo para pegar el código y **PA-13** en docs/22 con las tres alternativas.
Inventar un «últimos errores: ninguno» habría sido peor que la ausencia.

## Exportar la carta y los clientes: se cierra «exportar todo»

Faltaban las dos últimas de la lista de docs/26 —«catálogo, ventas, clientes,
kardex»—: ventas y kardex ya salían, catálogo y clientes no.

**La carta sale en el MISMO formato que lee el importador.** Es lo que convierte
un archivo para mirar en una herramienta de trabajo: se baja, se corrigen
cincuenta precios en Excel y se pega de vuelta, con su vista previa de qué
cambia. Por eso las cabeceras son `sku`, `nombre`, `categoria`, `precio_base`,
`precio_<canal>` y no rótulos bonitos en castellano: el archivo lo lee una
persona, pero también lo lee el importador.

**Y la ida y vuelta se comprueba de verdad, en el navegador.** La prueba baja el
archivo de verdad desde la pantalla, lo pega en el importador de verdad y exige
que no salga **ni una fila nueva ni una que cambie**. Decir «las columnas
coinciden» mirándolas no demuestra que un precio sobreviva al viaje; si el
export perdiera un precio, esa fila saldría como «cambia», y si perdiera el SKU
saldría como «nuevo». Es la clase de comprobación que le faltaba al presupuesto
de JS y a la prueba del enlace de seguimiento esta misma mañana.

Dos decisiones del formato, las dos por el mismo motivo —que el archivo se
reimporta—: un canal sin precio va **vacío y no en cero**, porque un cero es un
precio y reimportarlo regalaría el plato; y los **precios inactivos no salen**,
porque reimportarlos los resucitaría.

**Lo que no cabe, se cuenta.** El formato es plano y no tiene dónde poner «en
Miraflores cuesta otra cosa», así que los precios por local se quedan fuera y
`filasDeCarta` los CUENTA para que la pantalla pueda decirlo. Un export que se
calla lo que dejó fuera es peor que uno que no lo exporta: quien lo reimporta
cree que está aplicando la carta entera.

**Los clientes** salen por el mismo endpoint que la pantalla, así que heredan su
permiso (`crm.read`) y su aislamiento; quien no puede ver la lista tampoco puede
bajársela. Los anonimizados salen igual, marcados: sus pedidos siguen contando
para la contabilidad, y esconderlos dejaría un total que no cuadra con
Rentabilidad. Y el export arrastra la búsqueda de la pantalla, porque quien
filtró por «Ana» espera las de Ana.

### Y la suite de navegador enseñó otra vez lo mismo

Al ejecutarla fallaron diez pruebas que no tenían nada que ver con el cambio. La
causa: la API estaba sirviendo un `dist` **viejo**, de antes del reinicio del
contenedor, así que `/catalog/import` respondía 404 —ese endpoint es posterior—
y con él caían todas las funciones nuevas. No era un fallo del código: era una
API de otra versión contestando con naturalidad. Se añadió el paso al guion de
recuperación; el mismo patrón que en CI, donde el `dist` sin construir daba
«Cannot find module» en vez de «falta compilar».

## «Primera compra» y «cliente frecuente» en el pedido

Es uno de los «detalles que compran al operador» de docs/25, y era otro caso de
la familia que se repite en este proyecto: **el dato existía y no lo llamaba
nadie**. El CRM calcula desde F5 cuántas veces ha pedido cada teléfono; para
verlo había que salir del pedido, abrir Clientes y buscar el número. Nadie hace
eso con la cocina llena, así que la información estaba y no servía.

Ahora sale **arriba, junto al número del pedido**, que es donde mira quien coge
el teléfono.

**La regla vive en `@sahana/domain`, no en la pantalla.** El POS y el KDS van a
enseñar lo mismo, y tres superficies decidiendo por su cuenta qué es «frecuente»
es exactamente cómo el mismo cliente sale VIP en una pantalla y anónimo en la de
al lado. La API devuelve el **hecho** —cuántos pedidos tiene ese teléfono— y el
dominio decide la **etiqueta**.

**Lo que más importa que haga bien es callarse.** Sin teléfono no dice nada, y
esa distinción no es un detalle: en mostrador casi nunca hay teléfono, así que
tratar «no sé quién es» como «primera compra» marcaría mal la mayoría de los
pedidos de un local con caja. Hay prueba unitaria de cada rama y una de
navegador que busca un pedido sin teléfono y exige que no lleve etiqueta.

Y no lleva etiqueta **todo el mundo**: entre el segundo y el cuarto pedido no
dice nada. Si todas las tarjetas llevan distintivo, el distintivo deja de querer
decir «esta es distinta».

El umbral —cinco— **no lo fija la spec**, así que es una constante con nombre en
un solo sitio y queda como **PA-14** en docs/22: puede depender del rubro (una
pollería semanal no es una cafetería diaria) o ser configurable por el dueño.

Se contabilizan también los pedidos **cancelados**: para saber si alguien es de
los de siempre importa cuántas veces ha pedido, no cuántas terminaron bien.

## Las fechas del panel, en un solo sitio y con el día de la semana

Al ir a añadir la píldora de fecha que sugería la referencia del propietario
apareció el problema de debajo: había **seis formateadores de fecha distintos**
repartidos por las pantallas —dos llamados `momento`, dos llamados `fecha` y un
par sueltos dentro del JSX—, cada uno con sus opciones. El mismo instante salía
escrito de cuatro formas según la pantalla, y quien compara el histórico con la
caja tenía que traducir mentalmente entre dos formatos por gusto de nadie.

Ahora hay **un módulo** (`panel/fechas.ts`) con `diaConSemana`, `horaSola`,
`momento` y `esHoy`, y las seis copias han desaparecido.

**El día de la semana no es decoración.** Un operador no piensa en «22/08»,
piensa en «el sábado»: los picos de un negocio de comida son semanales, así que
al recorrer un listado la pregunta real es «¿esto fue un día fuerte o un
martes?», y la fecha sola obliga a hacer ese cálculo de cabeza en cada fila. En
los listados va como píldora de dos líneas —día arriba, hora debajo— para que la
columna no se ensanche y el ojo pueda recorrer los días sin leer la hora de cada
fila.

**El año se omite cuando es el año en curso.** Ocupa sitio y no informa: nadie
duda de en qué año está el pedido de anteayer.

Dos cosas que las pruebas fijan y conviene no perder:

· **Todo en hora de Lima, comparando el calendario y no restando horas.** Una
  venta de las 22:30 del sábado es del sábado aunque para UTC ya sea domingo. Y
  `esHoy` compara el día de Lima: a las 00:30, «hace menos de 24 horas» y «hoy»
  no son lo mismo, y esa diferencia es la que hace que un pedido de anoche
  aparezca como de hoy en el cierre del día.

· **Una fecha vacía devuelve una raya, no «Invalid Date».** Es la mitad del
  trabajo: los campos opcionales —aceptado, cerrado, entregado— están vacíos casi
  siempre al principio.

Las pruebas fijan «ahora» a propósito: una que dependa del reloj de la máquina
pasa hoy y falla en Nochevieja, que es justo el día en que nadie está mirando.
