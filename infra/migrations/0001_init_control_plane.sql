-- 0001 — Plano de control (SaaS) y convención de RLS.
-- Ejecutado por el rol migrador (dueño del esquema). Ver docs/09-multi-tenancy.md.
--
-- IMPORTANTE (revisar siempre este diff — toca tenancy): aquí se establece la
-- convención de aislamiento. Toda tabla de NEGOCIO creada después debe llevar
-- tenant_id NOT NULL + política RLS. El test de esquema (schema.test.ts) falla
-- el build si alguna tabla de negocio no la cumple.

-- gen_random_uuid() es parte del núcleo desde PostgreSQL 13 (no requiere
-- pgcrypto ni superusuario), coherente con que el rol migrador no es superuser.

-- ---------------------------------------------------------------------------
-- Plano de control: NO son datos de tenant (no llevan tenant_id). Se listan en
-- la allowlist del test de esquema. El rol de app solo los lee.
-- ---------------------------------------------------------------------------

CREATE TABLE ten_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  limits      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- marcas/locales/usuarios
  features    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- flags por defecto
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ten_tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended', 'deleting')),
  plan_id     uuid NOT NULL REFERENCES ten_plans (id),
  country     text NOT NULL DEFAULT 'PE',
  currency    text NOT NULL DEFAULT 'PEN',
  timezone    text NOT NULL DEFAULT 'America/Lima',
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- (La tabla de control `_migrations` la crea el runner de migraciones.)

-- ---------------------------------------------------------------------------
-- Feature flags por tenant: PRIMERA tabla de negocio. Patrón RLS de referencia.
-- ---------------------------------------------------------------------------

CREATE TABLE ten_feature_flags (
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  flag        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, flag)
);

-- RLS: habilitar + FORCE (aplica incluso al dueño de la tabla) + política.
--
-- Patrón NULL-safe obligatorio en TODA política de aislamiento:
--   NULLIF(current_setting('app.tenant_id', true), '')::uuid
-- Motivo: al terminar una transacción con SET LOCAL, PostgreSQL devuelve el
-- parámetro a su valor de reinicio, que es la CADENA VACÍA, no NULL. Sobre una
-- conexión reutilizada del pool, `''::uuid` reventaría la evaluación de la
-- política. Con NULLIF, la ausencia de contexto produce NULL → la comparación
-- es falsa → CERO filas (fail-closed). Nunca expone datos de otro tenant.
ALTER TABLE ten_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE ten_feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ten_feature_flags
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Índice caliente: toda consulta empieza por tenant_id (docs/09 §Rendimiento).
CREATE INDEX idx_feature_flags_tenant ON ten_feature_flags (tenant_id);
