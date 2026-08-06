-- 0003 — Outbox / Inbox transaccional (ADR-0007).
--
-- outbox: todo evento de dominio se INSERTa aquí EN LA MISMA transacción que el
-- cambio de estado. Un relay (FOR UPDATE SKIP LOCKED) lo publica a BullMQ y
-- marca published_at (at-least-once). Los consumidores deduplican por inbox
-- (exactamente-una-vez efectivo).

-- ---------------------------------------------------------------------------
-- OUTBOX. Lleva tenant_id (los eventos pertenecen a un tenant) pero necesita un
-- camino de lectura de sistema para el relay, que publica across-tenant. Ese
-- escape SOLO existe en outbox/inbox (tablas de plataforma de eventos), nunca
-- en tablas de datos de negocio: aunque el flag de sistema se active, jamás
-- expone filas de negocio de otro tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,          -- p.ej. order, tenant
  aggregate_id   text NOT NULL,
  event_type     text NOT NULL,          -- p.ej. order.accepted
  payload        jsonb NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,            -- NULL = pendiente de publicar
  attempts       integer NOT NULL DEFAULT 0
);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
-- missing_ok=true: si no hay tenant (contexto de sistema del relay), la
-- comparación da NULL(false) y decide el flag app.system.
CREATE POLICY tenant_or_system ON outbox
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  );

-- El relay barre lo no publicado por antigüedad.
CREATE INDEX idx_outbox_unpublished ON outbox (occurred_at)
  WHERE published_at IS NULL;
CREATE INDEX idx_outbox_tenant ON outbox (tenant_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- INBOX. Registro de procesamiento por consumidor. El consumidor lo escribe en
-- la MISMA transacción que su efecto (tenant-scoped) => idempotencia efectiva.
-- ---------------------------------------------------------------------------
CREATE TABLE inbox (
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  consumer      text NOT NULL,           -- nombre del handler
  event_id      uuid NOT NULL,           -- outbox.id
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer, event_id)
);

ALTER TABLE inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_system ON inbox
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  );
