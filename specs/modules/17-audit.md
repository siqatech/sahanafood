# Módulo: Audit
> Fase: 3 · ADRs: 0002

`audit_log` append-only (rol de app sin UPDATE/DELETE; export diario a objeto WORM). API interna `audit.record(action, entity, before, after, reason)` llamada por interceptor + explícitamente en acciones de docs/14#auditoria. Consulta: GET /audit?entity&actor&range (permiso audit.read, admin/contador). Soporte cross-tenant: motivo obligatorio, visible para el tenant afectado.
Pruebas: intento de UPDATE sobre audit_log falla a nivel de BD · toda acción de la lista genera registro (test por acción) · aislamiento.
