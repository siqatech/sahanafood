-- 0002 — Auditoría append-only (spec 17, docs/14-security.md#auditoria).
--
-- Regla innegociable: el rol de app NO tiene UPDATE ni DELETE sobre audit_log.
-- Un intento de UPDATE/DELETE debe fallar a nivel de base de datos. El registro
-- es inalterable. La retención/archivo se gestiona con rol privilegiado aparte.

CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL,          -- user | system | support
  actor_id      text,                   -- id de usuario / worker
  action        text NOT NULL,          -- p.ej. tenant.created, order.cancelled
  resource_type text NOT NULL,
  resource_id   text,
  trace_id      text,                   -- correlación con OTel
  reason        text,                   -- obligatorio en accesos de soporte
  data          jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE INDEX idx_audit_tenant_time ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_resource ON audit_log (tenant_id, resource_type, resource_id);

-- Append-only a nivel de privilegios: el rol de app solo INSERT + SELECT.
-- (Los ALTER DEFAULT PRIVILEGES conceden SELECT/INSERT/UPDATE/DELETE; aquí
-- REVOCAMOS UPDATE y DELETE explícitamente para esta tabla.)
REVOKE UPDATE, DELETE ON audit_log FROM sahana_app;
REVOKE UPDATE, DELETE ON audit_log FROM sahana_support;
