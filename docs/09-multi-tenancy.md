# Multi-tenancy

Estrategia: **BD compartida + `tenant_id` + Row Level Security como mecanismo principal** (ADR-0002). Camino a aislamiento dedicado para enterprise en F9 sin reescritura.

## Implementación obligatoria
1. Toda tabla de negocio: `tenant_id UUID NOT NULL` + política RLS `USING (tenant_id = current_setting('app.tenant_id')::uuid)`.
2. **Pooling en modo transacción** (pgBouncer/pool nativo). El contexto se fija con `SET LOCAL app.tenant_id = $1` **dentro de la transacción de cada request**. PROHIBIDO session pooling con SET de sesión: una conexión reutilizada filtraría tenant. Test de regresión específico para esto.
3. El rol de la aplicación NO tiene `BYPASSRLS`. Migraciones corren con rol separado.
4. FKs compuestas incluyendo `tenant_id` en relaciones críticas (líneas de pedido, movimientos de stock).
5. `tenant_id` derivado del JWT, nunca del body/query.
6. **Prueba de aislamiento por endpoint** (fixture 2 tenants) obligatoria en CI: sin ella el PR no se aprueba.
7. Consultas cross-tenant: solo rol `support` con motivo obligatorio → `audit_log`.
8. Restore por tenant: procedimiento en docs/20 (restaurar PITR a instancia efímera → `COPY` filtrado por tenant → validación → import). Ensayado trimestralmente.

## Rendimiento
- Índices compuestos empezando por `tenant_id` en toda consulta caliente.
- Particionamiento por rango de fecha en `ord_orders` y `audit_log` cuando superen 50M filas (no antes).
