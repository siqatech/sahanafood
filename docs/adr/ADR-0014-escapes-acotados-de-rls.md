# ADR-0014 — Escapes acotados de RLS para procesos sin tenant

| Campo | Valor |
|---|---|
| Estado | **Aceptado** (implementado en T3.08/T3.11; ampliado en T4.14) |
| Fecha | 7 de agosto de 2026 |
| Depende de | ADR-0002 (multi-tenant con RLS), ADR-0007 (outbox/inbox) |
| Revisar si | Aparece un **cuarto** caso que pida escape, o si el pentest de F5 cuestiona el patrón |

## Contexto

El ADR-0002 establece que toda tabla de negocio lleva `tenant_id` y una política
RLS que exige contexto de tenant. Pero dos procesos legítimos del sistema
operan **antes o por encima** de ese contexto:

1. **El relay de outbox** publica eventos de todos los tenants; no puede fijar
   un `tenant_id` porque barre la cola completa.
2. **El login** recibe un email antes de saber a qué tenant pertenece: resolver
   el tenant *es* el primer paso de la autenticación.
3. **El webhook de un marketplace** (añadido en T4.14) llega sin ningún token
   nuestro: lo único que trae es el `webhook_token` opaco de la URL. Resolver la
   conexión —y con ella el tenant— es el paso previo a poder verificar su firma.

Las salidas habituales son malas. Dar `BYPASSRLS` al rol de aplicación anula el
mecanismo de aislamiento entero y contradice `docs/09 §3`. Mantener una tabla
"directorio" de emails fuera de RLS duplica datos personales y crea una segunda
fuente de verdad que se desincroniza.

## Decisión

Se admite un **escape acotado**: una política RLS *permisiva adicional* activada
por un parámetro de sesión que solo fija un helper dedicado, con transacción
propia y corta. Tres restricciones lo hacen seguro y son parte de la decisión:

1. **Acotado por tabla.** Solo las tablas que lo necesitan consultan el flag:
   `app.system` en `outbox`/`inbox` y en `int_webhook_events` (que es
   infraestructura de eventos, no dato de negocio); `app.auth_lookup` en
   `idn_users`; `app.integration_lookup` en `int_connections`. Ninguna otra
   tabla de negocio lo menciona, así que activar el flag no puede exponer
   pedidos, catálogo ni cobros de otro tenant.
2. **Acotado por operación.** Los escapes de login y de integración son
   `FOR SELECT`. No habilitan INSERT, UPDATE ni DELETE en ninguna tabla.
3. **Acotado por vía de acceso.** El flag solo se fija dentro de `withSystem()`,
   `withAuthLookup()` y `withIntegrationLookup()`
   (`apps/api/src/database/rls.ts`), con `set_config(..., true)` local a la
   transacción. Ningún caso de uso de negocio los invoca: el resto de la
   aplicación pasa por `withTenant()`.
4. **Resolver no es autorizar.** `withIntegrationLookup` devuelve el secreto de
   firma para que el llamador verifique el HMAC; un `webhook_token` válido con
   firma inválida se rechaza con 401 y no encola nada. El escape abre la puerta
   a *saber a quién pertenece la URL*, no a escribir en su nombre.

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
- **+** El área a auditar es pequeña y explícita: tres funciones en un archivo y
  cinco políticas en las migraciones.
- **−** Cualquier tabla futura que copie las políticas de `outbox`/`inbox` sin
  entender el motivo ampliaría el escape. Mitigación: la revisión obligatoria
  del diff de migraciones (CLAUDE.md) y el test de esquema.
- **−** El endpoint de webhook SÍ es inducible por un tercero: cualquiera que
  conozca la URL provoca una ejecución de `withIntegrationLookup`. Es aceptable
  porque solo puede resolver la conexión de *ese* token (índice único) y el
  siguiente paso exige una firma que no puede producir. Queda como área
  prioritaria del pentest de F5.
- Verificación pendiente para el pentest de F5: confirmar que ningún endpoint
  puede inducir la ejecución de `withSystem`/`withAuthLookup` con entrada del
  usuario, y que el de webhook no permite enumerar tokens por tiempo de
  respuesta.
