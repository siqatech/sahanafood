# ADR-0014 — Escapes acotados de RLS para procesos sin tenant

| Campo | Valor |
|---|---|
| Estado | **Aceptado** (implementado en T3.08/T3.11) |
| Fecha | 7 de agosto de 2026 |
| Depende de | ADR-0002 (multi-tenant con RLS), ADR-0007 (outbox/inbox) |
| Revisar si | Aparece un tercer caso que pida escape, o si el pentest de F5 cuestiona el patrón |

## Contexto

El ADR-0002 establece que toda tabla de negocio lleva `tenant_id` y una política
RLS que exige contexto de tenant. Pero dos procesos legítimos del sistema
operan **antes o por encima** de ese contexto:

1. **El relay de outbox** publica eventos de todos los tenants; no puede fijar
   un `tenant_id` porque barre la cola completa.
2. **El login** recibe un email antes de saber a qué tenant pertenece: resolver
   el tenant *es* el primer paso de la autenticación.

Las salidas habituales son malas. Dar `BYPASSRLS` al rol de aplicación anula el
mecanismo de aislamiento entero y contradice `docs/09 §3`. Mantener una tabla
"directorio" de emails fuera de RLS duplica datos personales y crea una segunda
fuente de verdad que se desincroniza.

## Decisión

Se admite un **escape acotado**: una política RLS *permisiva adicional* activada
por un parámetro de sesión que solo fija un helper dedicado, con transacción
propia y corta. Tres restricciones lo hacen seguro y son parte de la decisión:

1. **Acotado por tabla.** Solo las tablas que lo necesitan consultan el flag:
   `app.system` en `outbox`/`inbox`; `app.auth_lookup` en `idn_users`. Ninguna
   otra tabla de negocio lo menciona, así que activar el flag no puede exponer
   pedidos, catálogo ni cobros de otro tenant.
2. **Acotado por operación.** El escape de login es `FOR SELECT`. No habilita
   INSERT, UPDATE ni DELETE en ninguna tabla.
3. **Acotado por vía de acceso.** El flag solo se fija dentro de `withSystem()`
   y `withAuthLookup()` (`apps/api/src/database/rls.ts`), con `set_config(...,
   true)` local a la transacción. Ningún caso de uso de negocio los invoca: el
   resto de la aplicación pasa por `withTenant()`.

Toda política de aislamiento usa además el patrón NULL-safe
`NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Motivo: al terminar
una transacción con `SET LOCAL`, PostgreSQL restaura el parámetro a la **cadena
vacía**, no a NULL; sobre una conexión reutilizada del pool, `''::uuid` haría
fallar la evaluación de la política. Con `NULLIF`, la ausencia de contexto da
NULL, la comparación es falsa y el resultado es **cero filas** (fail-closed).

## Alternativas rechazadas

- **`BYPASSRLS` en el rol de app** — rechazado: elimina la defensa principal
  para resolver dos casos marginales.
- **Tabla directorio de emails sin RLS** — rechazado: duplica datos personales y
  crea desincronización.
- **Tenant en el login (subdominio o selector)** — no rechazado, pero es una
  decisión de producto pendiente (PA-01 en `docs/22`). Si se adopta, el escape
  de `auth_lookup` puede eliminarse; el de `outbox` seguirá siendo necesario.

## Consecuencias

- **+** El aislamiento se mantiene íntegro para todos los datos de negocio; el
  rol de app nunca gana capacidad de saltarse RLS.
- **+** El área a auditar es pequeña y explícita: dos funciones en un archivo y
  tres políticas en las migraciones.
- **−** Cualquier tabla futura que copie las políticas de `outbox`/`inbox` sin
  entender el motivo ampliaría el escape. Mitigación: la revisión obligatoria
  del diff de migraciones (CLAUDE.md) y el test de esquema.
- Verificación pendiente para el pentest de F5: confirmar que ningún endpoint
  puede inducir la ejecución de `withSystem`/`withAuthLookup` con entrada del
  usuario.
