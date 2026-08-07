# Gate de salida — Fase 3 (Fundamentos)

> Evaluación de los criterios de `specs/phases/_gates-comunes.md` y de los
> específicos de `specs/phases/phase-3-fundamentos.md`.
> Fecha: 7 de agosto de 2026 · Evaluado sobre PostgreSQL 16 real.
>
> **Veredicto: APTO CON EXCEPCIONES.** Los tres gates duros de la fase están en
> verde y verificados. Quedan dos criterios sin cumplir, ambos documentados
> abajo con su motivo y su dueño: T3.16 (Terraform) y la demo grabada.

---

## 1. Gates duros específicos de la Fase 3

Son los tres que la fase declara como condición de salida. Los tres se
verifican automáticamente en CI, no por inspección.

| Gate | Exigencia | Resultado | Evidencia |
|---|---|---|---|
| Fuga de aislamiento con pooling agresivo | 1000 transacciones alternando tenants sobre la MISMA conexión, sin filtración | ✅ **VERDE** | `rls-isolation.test.ts` — además, `WITH CHECK` impide forjar filas de otro tenant |
| Evento sobrevive al kill del relay | exactamente-una-vez efectivo | ✅ **VERDE** | `outbox-exactly-once.test.ts` — el efecto no se duplica pese al reintento |
| Onboarding de tenant demo | < 60 s | ✅ **VERDE** | Medido: **50 ms** (`make demo-tenant`) |

---

## 2. Criterios comunes a toda fase

### 2.1 CI verde completo — ✅ CUMPLE

| Comprobación | Estado |
|---|---|
| ESLint (incluye regla anti-`number` monetario) | ✅ |
| Typecheck (TypeScript estricto) | ✅ |
| dependency-cruiser (fronteras de módulo) | ✅ 75 módulos, 0 violaciones |
| Prettier | ✅ |
| Pruebas unitarias de dominio | ✅ 97 |
| Integración contra Postgres real | ✅ 101 |
| **Aislamiento de tenant** | ✅ suite bloqueante sobre los 12 endpoints |
| SCA (`pnpm audit`) | ⚠️ informativo, no bloqueante — se endurece en F5 (pentest) |

**Total: 198 pruebas en verde.**

### 2.2 Cobertura de dominio — ✅ CUMPLE

| Módulo | Ramas | Exigencia |
|---|---|---|
| `money/` (Money + IGV) | **100 %** | 100 % (dinero) ✅ |
| `geo/` | 100 % | ≥ 90 % ✅ |
| `state-machine/` | 100 % | ≥ 90 % ✅ |
| `schedule/` | 91,7 % | ≥ 90 % ✅ |
| **Global** | **98,5 %** | ≥ 90 % ✅ |

Lo no cubierto en `schedule/` es una guarda defensiva contra variaciones de ICU
entre versiones de Node; se deja a propósito.

### 2.3 Cero deuda en dinero / tenancy / auditoría — ✅ CUMPLE

- **Dinero:** `Money` entero a escala 4, 100 % de ramas, regla de lint activa.
  Ninguna ruta de código calcula importes fuera de `@sahana/domain`.
- **Tenancy:** RLS habilitada, forzada y con política en toda tabla de negocio,
  verificado por test de esquema que rompe el build. Rol de app sin `BYPASSRLS`.
  FKs compuestas con `tenant_id` en la jerarquía de organización.
- **Auditoría:** `audit_log` append-only garantizado por privilegios de BD
  (`REVOKE UPDATE, DELETE`), probado.

Deuda restante registrada en `docs/23-technical-debt.md` con fecha.

### 2.4 Specs actualizadas ante divergencia — ✅ CUMPLE

| Divergencia | Registro |
|---|---|
| `Money` en céntimos vs 4 decimales en subtotales | ADR-0013 |
| RLS fail-closed con error vs pooling transaccional | ADR-0014 + comentario en migración 0001 |
| Login sin contexto de tenant | ADR-0014 |
| Polígonos `geography` (PostGIS) → dominio compartido | ADR-0015 + nota en `specs/modules/03-organization.md` |

### 2.5 progress.md actualizado y demo grabable — ⚠️ PARCIAL

- `docs/progress.md`: ✅ actualizado con estado por tarea y evidencia.
- **Demo grabada: ❌ NO ENTREGADA.** Requiere captura de pantalla/vídeo por una
  persona. El alcance es reproducible por comandos (ver `README.md`), pero la
  grabación es un entregable humano. **Dueño: propietario del producto.**

### 2.6 Checklist OWASP de la fase — ✅ CUMPLE (sin hallazgos altos)

Aplicado a la superficie existente (autenticación, tenancy, organización).

| OWASP Top 10 | Estado en F3 |
|---|---|
| A01 Control de acceso roto | Guard global `@RequirePermission` verificado en backend; permisos con ámbito; **suite de aislamiento sobre todos los endpoints**; RLS como segunda barrera |
| A02 Fallos criptográficos | Contraseñas y PIN con argon2id; refresh y tokens de dispositivo guardados como sha256, nunca en claro; TLS es responsabilidad del despliegue (F3.16) |
| A03 Inyección | Consultas parametrizadas siempre, incluido `set_config` del tenant; validación zod en el borde |
| A04 Diseño inseguro | Bloqueo de PIN persistido en BD; código de emparejamiento de un solo uso garantizado por la BD; revocación de familia ante reuso de refresh |
| A05 Configuración insegura | Config validada al arranque (el proceso no arranca si falta un secreto); rol de BD sin privilegios de más; `/metrics` fuera del prefijo público |
| A06 Componentes vulnerables | `pnpm audit` en CI (informativo; bloqueante desde F5) |
| A07 Fallos de identificación | JWT corto + refresh rotativo con detección de reuso; mensajes de login que no revelan existencia de cuenta; bloqueo por intentos |
| A08 Integridad de datos/software | Outbox transaccional; `audit_log` inalterable; migraciones versionadas y revisadas a mano |
| A09 Fallos de registro y monitoreo | Auditoría append-only; logs estructurados con `tenant_id` y `trace_id`; métricas de seguridad (reuso de refresh, bloqueos de PIN); traza request→outbox→worker |
| A10 SSRF | Sin llamadas salientes controladas por el usuario en esta fase |

**Sin hallazgos altos abiertos.** Pendiente por fase: MFA (F5), cifrado campo a
campo con KMS (F5), rate limiting (F5), pentest externo (gate de F5).

### 2.7 Aprobación del propietario — ⏳ PENDIENTE

Este documento es la solicitud.

---

## 3. Backlog de la Fase 3: estado final

| ID | Tarea | Estado |
|---|---|---|
| T3.01 | Monorepo + tooling + dependency-cruiser | ✅ Finalizada |
| T3.02 | docker compose + Makefile | ✅ Finalizada |
| T3.03 | `@sahana/domain`: Money + property tests | ✅ Finalizada |
| T3.04 | apps/api NestJS + Problem Details | ✅ Finalizada |
| T3.05 | Drizzle + RLS `withTenant` + pool transaccional | ✅ Finalizada |
| T3.06 | Test de esquema RLS | ✅ Finalizada |
| T3.07 | Módulo Tenancy | ✅ Finalizada |
| T3.08 | Módulo Identity | ✅ Finalizada |
| T3.09 | Dispositivos POS + PIN | ✅ Finalizada |
| T3.10 | Módulo Audit | ✅ Finalizada |
| T3.11 | Outbox/inbox + relay | ✅ Finalizada |
| T3.12 | Módulo Organization | ✅ Finalizada |
| T3.13 | Harness de aislamiento | ✅ Finalizada |
| T3.14 | OTel + métricas Prometheus | ✅ Finalizada |
| T3.15 | CI/CD | ✅ Finalizada |
| **T3.16** | **Terraform dev** | ❌ **NO ENTREGADA** |
| T3.17 | Onboarding tenant demo < 60 s | ✅ Finalizada |
| T3.18 | Gate F3 | 🔵 Este documento |

### 3.1 Por qué T3.16 no se entrega

Escribir la definición de Terraform es posible; **aplicarla y verificarla no lo
es sin credenciales de un proveedor cloud**. Entregar infraestructura como
código que nunca se ha ejecutado sería el único artefacto de esta fase sin
prueba de que funciona, y precisamente el que más caro sale cuando falla: un
`terraform apply` que revienta a mitad deja recursos huérfanos y facturables.

**Decisión:** queda pendiente hasta disponer de cuenta cloud. No bloquea la
Fase 4, que se desarrolla y verifica en local con Docker.
**Dueño: propietario del producto** (proveer credenciales o decidir proveedor).

---

## 4. Lo que esta fase deja construido

Más allá del checklist, lo que la Fase 4 puede dar por hecho:

- **Aislamiento multi-tenant** que no depende de la disciplina del programador:
  RLS + test de esquema + harness por endpoint + FKs compuestas.
- **Dinero exacto** con un único punto de cálculo, compartido con el futuro POS
  offline.
- **Eventos que no se pierden**, con exactamente-una-vez efectivo y traza que
  sobrevive al salto por la cola.
- **Autenticación y permisos con ámbito** listos para que cualquier módulo nuevo
  declare `@RequirePermission` y quede protegido.
- **Auditoría inalterable** a nivel de base de datos.
- **Jerarquía organizativa** con marca⟷cocina M:N, cobertura y horarios.

---

## 5. Riesgos técnicos: estado tras F3

| Riesgo | Antes | Ahora |
|---|---|---|
| R-03 Fuga entre tenants | Mitigándose | ✅ **Mitigado y verificado** |
| R-04 Descuadre por float | Mitigándose | ✅ **Mitigado y verificado** |
| R-07 Pérdida de eventos | Mitigado por diseño | ✅ **Mitigado y verificado** |
| R-05 Divergencia offline/servidor | Mitigado por diseño | 🔵 Se verifica en F4 con el POS real |
| R-12 Equipo sin experiencia TS | Abierto | 🔴 **Abierto — DP-01** |

---

## 6. Solicitud de aprobación

Se solicita aprobación para **cerrar la Fase 3 y abrir la Fase 4**, aceptando
las dos excepciones documentadas (T3.16 y demo grabada), ambas con dueño humano
y ninguna bloqueante para el desarrollo de la Fase 4.
