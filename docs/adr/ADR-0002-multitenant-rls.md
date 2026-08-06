# ADR-0002 — Multi-tenant: BD compartida + RLS

Estado: Propuesto · Fecha: 2026-08-05

## Decisión
`tenant_id` en toda tabla + Row Level Security como mecanismo principal, con pooling EN MODO TRANSACCIÓN y `SET LOCAL app.tenant_id` por request. Rol de app sin BYPASSRLS. FKs compuestas en relaciones críticas. Prueba de aislamiento por endpoint en CI. Aislamiento dedicado por tenant: solo enterprise (F9), enrutado por conexión, mismo esquema.

## Alternativas
Esquema por tenant (rechazado: migraciones ×N, degrada con miles), BD por tenant (rechazado como default: costo lineal), solo filtro en aplicación (rechazado: un olvido = fuga).

## Consecuencias
+ Barato, una migración, restore selectivo posible (docs/20). − Overhead RLS (~aceptable con índices por tenant_id); riesgo de session pooling → prohibido y testeado; consultas globales requieren rol especial auditado.

Revisar si: cliente exige residencia/aislamiento contractual; p95 de RLS demostrablemente > 15% del tiempo de consulta.
