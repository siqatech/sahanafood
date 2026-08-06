# Backups y recuperación

- PostgreSQL: backups automáticos diarios + WAL continuo → **PITR, RPO ≤ 5 min**. Retención 30 días + snapshot mensual 12 meses. Copia cifrada en segunda región/cuenta.
- Objetos (imágenes, XML/PDF de comprobantes): versionado + replicación; los comprobantes además en almacenamiento WORM (retención fiscal 5 años).
- Redis: efímero por diseño (caché) SALVO colas: BullMQ con AOF everysec; si se pierde, el outbox permite reconstruir publicaciones no confirmadas (por eso el outbox es la fuente de verdad, ADR-0007).
- Restore por tenant: PITR a instancia efímera → export filtrado por tenant_id → validación de conteos → import con RLS desactivado por rol de migración → verificación. Runbook en docs/24. **Ensayo trimestral cronometrado** (objetivo < 4 h).
- DR completo: infra reconstruible por Terraform + último base backup + WAL. **RTO ≤ 4 h (MVP)**. Ensayo semestral.
- La venta en local NO depende del DR: POS offline cubre continuidad (RTO de venta = 0).
