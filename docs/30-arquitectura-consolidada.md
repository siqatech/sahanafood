# Arquitectura consolidada — revisión de arquitecto

> Documento de revisión, no de reemplazo. `docs/08-architecture.md` sigue siendo
> la vista de contenedores; los ADR siguen siendo las decisiones. Esto consolida
> cómo encajan entre sí, qué está construido y verificado hoy, qué
> **inconsistencias reales** aparecieron al implementar, y cómo crece el sistema
> sin rehacerse.
>
> Fecha: 7 de agosto de 2026 · Estado de la base: Fase 3 en ejecución.

---

## 0. Resumen para decidir

La arquitectura del paquete v1.0 es sólida y no necesita rediseño. Las
decisiones difíciles —monolito modular, RLS, outbox transaccional, dominio
compartido con el POS offline— son las correctas para un SaaS de este perfil, y
las cuatro correcciones del comité (impresión, eventos, aislamiento, números)
eliminan los errores que suelen matar un producto de este tipo en producción.

Lo que faltaba no era diseño sino **ejecución verificable**. Eso es lo que se
construyó: un núcleo donde el aislamiento, la exactitud del dinero y la no
pérdida de eventos no son promesas del documento sino pruebas que rompen el
build. Las inconsistencias encontradas (§2) son de detalle, todas resueltas o
registradas con dueño.

**Lo que sigue siendo la decisión humana pendiente:** DP-01 (quién ejecuta) y
PA-01 (si un email puede pertenecer a varios tenants). Ninguna bloquea el
avance técnico hoy; PA-01 sí bloquea cerrar Identity.

---

## 1. Qué existe y está verificado hoy

No es una lista de intenciones: cada línea tiene una prueba que la respalda y
corre en CI.

| Capacidad | Mecanismo | Verificación |
|---|---|---|
| Aislamiento entre clientes | RLS + `withTenant` (`SET LOCAL` por transacción) sobre pool en modo transacción | 1000 transacciones alternando tenants en la **misma conexión**, cero filtración; `WITH CHECK` impide forjar filas ajenas |
| Ninguna tabla se olvida del aislamiento | Test de esquema sobre `pg_class`/`pg_policies` | Falla el build si una tabla de negocio nace sin `tenant_id` + RLS forzada + política |
| Exactitud del dinero | `Money` entero escala 4 en `@sahana/domain` | 100 % de ramas; property tests: `a+b−b=a`, reparto sin pérdida, `neto+IGV=bruto` |
| No perder eventos | Outbox en la misma transacción + relay `FOR UPDATE SKIP LOCKED` + dedupe por inbox | El efecto **no se duplica** aunque el relay muera después de publicar |
| Auditoría inalterable | `REVOKE UPDATE, DELETE` al rol de app | `UPDATE audit_log` falla a nivel de base de datos |
| Autenticación robusta | argon2id + JWT corto + refresh rotativo | Reuso de refresh revoca la familia y queda auditado |
| Autorización con ámbito | `@RequirePermission` global + permisos por rol y ámbito | Matriz permiso×rol de `docs/03`; supervisor del local A no cubre el local B |
| Límites de plan | Cerrojo `FOR UPDATE` por tenant antes de crear | Dos peticiones al borde del límite se serializan; 429 con mensaje de upgrade |

**87 pruebas en verde** (38 de API contra Postgres real + 49 de dominio).

---

## 2. Inconsistencias encontradas al implementar

Estas son contradicciones reales entre documentos, o supuestos que no
sobreviven al contacto con la ejecución. Ninguna es grave; todas necesitan que
alguien decida y quede escrito.

### 2.1 Resueltas (con ADR)

**«Money en céntimos» vs «subtotales con 4 decimales».** `CLAUDE.md` dice
enteros en céntimos (2 decimales); RN-T04 exige que los subtotales conserven 4 y
la BD usa `NUMERIC(14,4)`. Son incompatibles si se toman literalmente.
→ **ADR-0013**: la representación interna es entero a escala 4; el redondeo
half-up a 2 decimales se aplica al total y al comprobante. «Céntimos» en la
prosa del proyecto significa, con precisión, «unidades menores a escala 4».

**RLS «fail-closed con error» vs pooling en modo transacción.** El diseño
inicial usaba `current_setting('app.tenant_id')` sin `missing_ok`, para que una
consulta sin contexto fallara ruidosamente. Pero al terminar una transacción,
PostgreSQL restaura el parámetro a la **cadena vacía**, no a NULL: sobre una
conexión reutilizada, `''::uuid` revienta la evaluación de la política y tumba
peticiones legítimas.
→ Patrón obligatorio `NULLIF(current_setting('app.tenant_id', true), '')::uuid`
en toda política. Sigue siendo fail-closed: sin contexto, **cero filas**.

**El login necesita el tenant antes de conocerlo.** Ninguna spec resolvía cómo
autenticar cuando el aislamiento exige un tenant que aún no se ha resuelto.
→ **ADR-0014**: escape acotado por tabla (`idn_users`), por operación (solo
`SELECT`) y por vía de acceso (un helper dedicado). El rol de app nunca gana
`BYPASSRLS`.

### 2.2 Abiertas — requieren tu decisión

| # | Inconsistencia | Impacto | Registro |
|---|---|---|---|
| 1 | **¿Dónde viven las migraciones?** `CLAUDE.md` dice `infra/migrations/`; `docs/29` (plantilla de módulo) dice `src/modules/<x>/migrations/`. Se implementó `infra/migrations/` con numeración global. | Bajo, pero hay que unificar antes de que 19 módulos lo interpreten distinto. **Recomiendo mantener `infra/migrations/`**: el orden global importa (las FK cruzan módulos) y el diff de tenancy/dinero debe revisarse en un solo sitio. | §2.2 aquí |
| 2 | **¿Drizzle Kit o SQL versionado a mano?** ADR-0006 menciona Drizzle Kit; se implementó un runner de SQL explícito. Motivo: las políticas RLS, los `REVOKE` y los índices parciales **no** los genera Drizzle Kit, y el diff debe ser legible por un humano (regla de revisión de CLAUDE.md). Drizzle sigue usándose para consultas tipadas. | Bajo. **Recomiendo formalizar el SQL a mano** como decisión y actualizar ADR-0006. | Pendiente de ADR |
| 3 | **¿Un email puede estar en varios tenants?** Sin definir en spec 02. Hoy se rechaza el login ambiguo en vez de adivinar. | Alto para onboarding y para un operador que trabaja con dos clientes. | PA-01 en `docs/22` |
| 4 | **Límites de plan de marcas y locales.** Spec 01 los define, pero las entidades llegan en T3.12; hoy solo se hace cumplir el de usuarios. | Medio. Se cierra con T3.12. | PA-02 |
| 5 | **¿Roles del sistema editables?** Se crean `is_system = true` sin API de edición. | Medio. | PA-03 |
| 6 | **API móvil no está en el alcance escrito.** El paquete cubre PWA (POS, KDS, repartidor) pero no fija el contrato para una app nativa futura. | Ver §9. La API ya es apta; falta declararlo. | Este documento |

---

## 3. Arquitectura general y separación de módulos

Se mantiene el **monolito modular** (ADR-0001). Con dos a cuatro personas,
microservicios cambiarían un problema que sabemos resolver (fronteras de código)
por uno que no (consistencia distribuida y operación).

Lo que hace que este monolito no degenere en una bola de barro no es la
disciplina, es la **verificación automática**:

- Cada módulo expone su API pública en `modules/<x>/index.ts`.
- `dependency-cruiser` rompe el build si un módulo importa internals de otro,
  si aparece un ciclo, o si el dominio toca infraestructura. Corre en CI.
- Prefijo de tabla por módulo (`ten_`, `idn_`, `ord_`, `cat_`…). Prohibido leer
  tablas ajenas: se pasa por la interfaz pública o por un evento.

**Lección ya aplicada:** al implementar apareció un ciclo real —Identity escribe
auditoría, Audit necesita el guard de permisos—. La solución no fue relajar la
regla sino separar el **decorador** (metadatos puros, en `common/authz.ts`, sin
dependencias) del **guard** (en Identity, que consume `AuthService`). Es el
patrón a seguir cuando dos módulos parecen necesitarse mutuamente: casi siempre
uno de los dos lados es contrato, no implementación, y el contrato sube a
`common/`.

**Camino de extracción** (solo con medición y ADR nuevo): 1.º ingestor de
integraciones, 2.º gateway de tiempo real, 3.º analítica. El dominio no se
extrae nunca.

---

## 4. Backend, frontend y administración

| Superficie | Tecnología | Estado |
|---|---|---|
| `apps/api` | NestJS, monolito modular | Base construida (F3) |
| `apps/web` | Next.js: panel de gestión + tienda por marca | F4 (UI mínima) / F5 (tienda) |
| `apps/pos` | PWA React offline-first: POS + KDS | F4 |
| `apps/print-agent` | Node local, ESC/POS | F4 |
| `packages/domain` | `@sahana/domain`: Money, IGV, totales, máquina de estados | Construido |
| `packages/contracts` | DTOs zod compartidos | Base construida |

La decisión que sostiene todo esto: **el cálculo de totales vive una sola vez**
y corre idéntico en servidor y en el POS offline. Un total distinto entre POS y
servidor produce un comprobante SUNAT incorrecto, que en Perú es un problema
tributario, no un bug. Por eso el POS es PWA y no nativo (ADR-0006 §3.2).

La administración interna de Sahana (soporte) es una superficie aparte, no un
rol escondido en el panel del cliente: acceso cross-tenant con **motivo
obligatorio** que se escribe en `audit_log` y es visible para el tenant afectado.

---

## 5. Modelo de datos y estrategia multi-tenant

**Base compartida + `tenant_id` + RLS** (ADR-0002), con camino a aislamiento
dedicado para clientes enterprise en F9 **sin reescritura**: el mismo esquema se
despliega en una instancia propia y la aplicación no cambia.

Reglas no negociables, ya implementadas y probadas:

1. Toda tabla de negocio: `tenant_id UUID NOT NULL` + RLS `ENABLE` **y** `FORCE`
   + política de aislamiento.
2. Pool en **modo transacción**; contexto con `set_config(..., true)`
   parametrizado dentro de la transacción. Nunca `SET` de sesión.
3. El rol de aplicación **no** tiene `BYPASSRLS` ni es superusuario. Las
   migraciones corren con un rol distinto, dueño del esquema.
4. `tenant_id` derivado del token. Ningún endpoint lo acepta del cuerpo.
5. FKs compuestas con `tenant_id` en relaciones críticas (líneas de pedido,
   movimientos de stock) — **pendiente**, aplica desde F4.
6. Índices compuestos empezando por `tenant_id` en toda consulta caliente.
7. Particionar `ord_orders` y `audit_log` por fecha **solo** al superar 50 M
   filas. No antes: complejidad sin beneficio.

---

## 6. APIs y contratos

REST versionada `/api/v1`. Errores en **Problem Details (RFC 9457)** con
`traceId` incluido, ya funcionando. Validación con zod en el borde; el dominio
asume datos válidos y valida invariantes de negocio.

- **Contratos compartidos** en `packages/contracts`: los tipos entre backend y
  clientes son código verificado en compilación, no documentación. Un cambio de
  campo en el pedido rompe la construcción del KDS antes de producción.
- **Dinero en DTOs**: siempre entero de unidades menores + moneda. Jamás decimal
  de punto flotante.
- **Anti-corruption layer**: cada conector externo (marketplace, pasarela, OSE,
  WhatsApp) traduce a contratos internos. El dominio nunca ve payloads de
  proveedor — esto es lo que permite cambiar de proveedor sin tocar el dominio.
- **Idempotencia** (ADR-0010): `(tenant_id, channel, external_id)` única para
  pedidos externos; `Idempotency-Key` en POST de clientes propios; ULID generado
  en el cliente como clave natural del POS offline.

---

## 7. Autenticación, permisos, seguridad y auditoría

Construido y probado (§1). Lo relevante para escalar:

- **Permiso = `modulo.accion` + ámbito** (empresa/marca/local/cocina). El mismo
  rol «supervisor» aplica a locales distintos para usuarios distintos sin
  duplicar roles. Verificación **siempre** en backend.
- **Un guard global**: cualquier módulo futuro declara `@RequirePermission` y
  queda protegido sin configuración. Un endpoint sin decorador es público de
  forma explícita, no por olvido.
- **Refresh rotativo con familias**: reusar un refresh revoca la familia entera.
  Aquí hubo un bug real y sutil que la prueba capturó: revocar *dentro* de la
  transacción que lanza el error deshacía la revocación por el rollback, dejando
  vivo el token robado. Ahora la revocación se confirma antes de rechazar.
- **Pendiente por fase**: MFA TOTP (obligatoria para admin en v1), cifrado campo
  a campo con clave por tenant vía KMS para credenciales de conectores, rate
  limiting concreto (100/min usuario, 1000/min tenant, 20/min login), threat
  model STRIDE (F2) y pentest externo como gate de F5.

---

## 8. Escalabilidad, rendimiento, caché, colas y tareas programadas

Los objetivos son números, no adjetivos: p95 < 500 ms en transiciones de pedido,
pedido visible en KDS < 5 s, agotados propagados < 60 s, 2 000 pedidos/hora con
picos de 10×, RPO 5 min, RTO plataforma 4 h, **RTO de venta en local = 0**
gracias al offline.

- **Colas BullMQ sobre Redis.** Todo lo pesado en CPU —reportes, PDF, imágenes,
  exportaciones— va a workers. Nunca en el proceso que atiende peticiones: Node
  es de un solo hilo y un reporte pesado bloquearía las ventas.
- **Caché en Redis** para catálogo y disponibilidad, con invalidación por evento
  del outbox (no por TTL a ciegas: un agotado debe propagarse en menos de 60 s).
- **Tiempo real** con WebSockets de Nest + adaptador Redis. Mantener miles de
  conexiones de KDS abiertas durante el turno es el modo normal de operación,
  no un pico.
- **Tareas programadas**: BullMQ repeatable jobs (cierres, liquidaciones,
  reintentos de comprobantes). El relay de outbox ya corre con lote 100 cada
  250 ms.
- **Disparador documentado**: si BullMQ deja de sostener el volumen con pérdida
  o retraso demostrado, se migra a RabbitMQ (ADR-0006 §6.3). Medición primero.

---

## 9. Preparación para una aplicación móvil

No está en el alcance escrito, así que lo dejo declarado: **la API ya es apta
para móvil nativo sin cambios estructurales**, y estas son las razones por las
que lo seguirá siendo si se respetan:

1. La API es REST versionada y sin estado de sesión en servidor: el mismo
   contrato sirve a web, PWA y nativo.
2. La autenticación es JWT + refresh rotativo, el modelo estándar para móvil.
   El único ajuste necesario será almacenamiento seguro del refresh en el
   dispositivo (Keychain/Keystore) y registro de dispositivo, que ya existe
   como concepto para el POS (RN-IDN-04).
3. Los DTOs viven en `packages/contracts`: una app en React Native los consume
   directamente; una app en Swift/Kotlin los consume vía el esquema generado.
4. La idempotencia con ULID de cliente (ADR-0010) es exactamente lo que una app
   móvil con conectividad intermitente necesita.

**Recomendación**: no abrir la plataforma móvil hasta tener necesidad
demostrada (geolocalización en segundo plano del repartidor es el único caso
claro). Cada plataforma adicional es un canal más que mantener sincronizado.

---

## 10. Errores, logs, monitoreo y respaldos

- **Errores**: clases de error de dominio por módulo → mapper global a Problem
  Details. Nunca se filtra un error de Drizzle o de `pg` al cliente (ya
  implementado: los no controlados degradan a 500 genérico con `traceId`).
- **Logs** estructurados (pino) con `tenant_id` y `trace_id` en contexto;
  `console.log` prohibido por lint. Cabeceras sensibles redactadas.
- **Trazabilidad**: `trace_id` ULID por petición, propagado a la respuesta, a
  los logs y —esto es lo que lo hace útil— al outbox, de modo que una petición
  se sigue hasta el worker que la procesó.
- **Monitoreo**: OpenTelemetry + Prometheus + Grafana + Sentry (T3.14, en
  curso). Métrica de salud crítica ya expuesta: **outbox sin publicar > 1 000 →
  alerta**.
- **Respaldos**: PITR con RPO 5 min; restore **selectivo por tenant** ensayado
  trimestralmente (`docs/20`). Un respaldo que no se ha restaurado nunca no es
  un respaldo.

---

## 11. Integraciones externas

Todas siguen el mismo patrón: **adaptador + traducción a contrato interno +
webhook firmado con anti-replay + dedupe por inbox**. El dominio no se entera de
quién es el proveedor.

| Integración | Estrategia | Fase |
|---|---|---|
| WhatsApp Cloud API | Conector propio; plantillas e interactivos. El **costo por conversación es variable de diseño**, no detalle: flujos de mínimos turnos y KPI de mensajes por pedido | 4 / 5 |
| SUNAT | **Delegada a OSE/PSE autorizado** con adaptador. Exime de homologación propia. Correlativo transaccional sin huecos; emisión diferida dentro del límite normativo cuando hay corte | 4 / 5 |
| Pasarela de pago | Tokenización siempre. **Cero datos de tarjeta** en nuestra infraestructura (SAQ-A) | 4 / 5 |
| Marketplaces (Rappi, PedidosYa) | **Simulador primero** (F4). No entran en la ruta crítica del MVP: exigen convenio comercial y certificación. El simulador certifica el orquestador antes de tocar la API real | 4 sim. / 7 real |
| Correo transaccional | Adaptador con plantillas editables por tenant | 5 |
| LLM | Adaptador `AiProvider`; determinista primero (ADR-0011). El modelo **nunca** redacta precios, stock ni zonas de memoria: los consulta por herramientas tipadas y un validador rechaza cualquier precio que no venga de una herramienta | 5 |

---

## 12. Infraestructura, despliegue, ambientes y CI/CD

- **Docker sin Kubernetes** en F3–F6. Kubernetes resolvería problemas que este
  producto no tiene y añadiría operación que este equipo no puede pagar.
- **Ambientes**: local (compose, ya funciona) → dev (Terraform, T3.16) →
  staging → producción.
- **CI ya en marcha**: `static` (lint, tipos, fronteras, formato) · `domain`
  (100 % de ramas en dinero) · `integration` (Postgres 16 real: fuga ×1000,
  esquema, outbox) · `build` · `sca`.
- **Migraciones**: SQL versionado, revisado a mano, aplicado con rol migrador.
  Compatibles hacia atrás (expand/contract) para desplegar sin ventana.

---

## 13. Estrategia de pruebas y calidad

La pirámide está invertida a propósito respecto de lo habitual: **el peso está
en integración con base de datos real**, porque los riesgos de este producto
(aislamiento, dinero, pérdida de eventos) no se detectan con mocks.

1. **Dominio** — unitarias + property tests. Gate: 100 % de ramas en dinero.
2. **Integración** — Postgres 16 real. Aquí viven los gates de fase.
3. **Aislamiento por endpoint** — fixture de 2 tenants, **obligatoria para todo
   endpoint nuevo**. Sin ella el PR no se aprueba.
4. **e2e por superficie** — desde F4.
5. **Adversariales** — suite de conversaciones doradas y validador
   anti-precio-inventado (F5).

Regla que ya demostró su valor: las tres pruebas que más costaron escribir
—fuga con pooling, exactamente-una-vez, reuso de refresh— son las tres que
encontraron bugs reales.

---

## 14. Riesgos técnicos y deuda

Los 14 riesgos con dueño están en `docs/22`. Estado de los técnicos tras F3:

| Riesgo | Estado |
|---|---|
| R-03 Fuga entre tenants | **Mitigado y verificado** (fuga ×1000, test de esquema, aislamiento por endpoint) |
| R-04 Descuadre por float | **Mitigado y verificado** (Money entero, lint, 100 % ramas) |
| R-05 Divergencia offline/servidor | Mitigado por diseño; se verifica en F4 con el POS real |
| R-07 Pérdida de eventos | **Mitigado y verificado** (exactamente-una-vez bajo kill) |
| R-12 Equipo sin experiencia TS | **Abierto — DP-01**. Único riesgo que puede cambiar el stack |

**Deuda técnica aceptada y con fecha:**

- Sin interceptor de auditoría automático: hoy cada caso de uso llama a
  `recordAudit`. Se automatiza al llegar los módulos de F4, cuando haya
  suficientes acciones para justificar el patrón.
- Harness de aislamiento aún no extraído como helper genérico (T3.13).
- Sin MFA (deuda permitida explícitamente en F3).
- FKs compuestas con `tenant_id`: aplican desde F4, cuando existan las
  relaciones críticas.

---

## 15. Plan de implementación por fases

Sin cambios respecto de `docs/21-roadmap.md`; se confirma el orden. Lo que
añade esta revisión es la secuencia inmediata:

| Fase | Esencia | Gate más duro |
|---|---|---|
| **3 (en curso)** | Fundamentos: RLS, identidad, auditoría, outbox, CI/CD | Los tres gates duros **ya están en verde** |
| 4 | Catálogo, orquestador, POS offline + print-agent, caja, KDS, OSE sandbox, simulador | Día de operación con 2 cortes de internet y cierre cuadrado |
| 5 | Tienda, pagos, bandeja, agente IA, delivery | Suite dorada; validador adversarial; pentest sin altos; 3 pilotos reales |
| 6 | Inventario y costos reales | Conciliación teórico vs real con brecha explicada |
| 7 | Marketplaces reales | 2 semanas de piloto ≥ 98 % de éxito |
| 8 | CRM, personal, analítica (Python) | Conciliación diaria 30 días en verde |
| 9 | Escala: aislamiento dedicado, multi-país, HA | Game day de DR regional |

**Siguiente tramo concreto de F3:**

1. **T3.12 Organization** — jerarquía empresa/marca/local/cocina M:N y zonas.
   Es la siguiente pieza correcta porque **desbloquea los ámbitos reales de
   permisos** (hoy `scope_id` existe pero no apunta a nada) y cierra PA-02.
2. **T3.09** dispositivos POS + PIN argon2 (`safeEqual` ya disponible).
3. **T3.13** extraer el harness de aislamiento como helper reutilizable.
4. **T3.14** OTel + Sentry. **T3.16** Terraform dev. **T3.18** gate de fase.

---

## 16. Qué decidir ahora

| Decisión | Por qué importa | Recomendación |
|---|---|---|
| **DP-01 — quién ejecuta** | Único disparador que cambia el stack. Con equipo PHP la decisión correcta es Laravel + Flutter aceptando la duplicación del cálculo | Confirmar. Si el equipo es TypeScript o si el desarrollo sigue siendo asistido, ADR-0006 queda firme |
| **PA-01 — email multi-tenant** | Bloquea cerrar Identity y condiciona el onboarding | Recomiendo **prohibirlo globalmente** en el MVP: es el modelo más simple y el que menos sorpresas da. Si un operador debe atender a dos clientes, que use dos emails |
| **Inconsistencia 1 — migraciones** | Evita que 19 módulos la interpreten distinto | Mantener `infra/migrations/` y corregir `docs/29` |
| **Inconsistencia 2 — Drizzle Kit** | El SQL a mano ya es la práctica real | Formalizar con ADR y actualizar ADR-0006 |
