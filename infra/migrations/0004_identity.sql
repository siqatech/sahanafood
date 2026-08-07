-- 0004 — Módulo Identity (spec 02): usuarios, roles con ámbito, sesiones.
--
-- REVISAR SIEMPRE ESTE DIFF: toca tenancy y autenticación.
--
-- Diseño de login: el email llega ANTES de conocer el tenant, y las tablas de
-- negocio tienen RLS estricta. En vez de una tabla-directorio duplicada o un
-- rol con BYPASSRLS, se usa el mismo patrón de escape acotado que outbox/inbox:
-- una política PERMISIVA adicional, SOLO para SELECT, activada por el flag
-- `app.auth_lookup` que fija exclusivamente el helper de login (transacción
-- corta y dedicada). Escrituras y todo lo demás siguen exigiendo tenant.

-- ---------------------------------------------------------------------------
-- Usuarios
-- ---------------------------------------------------------------------------
CREATE TABLE idn_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  email         text NOT NULL,
  password_hash text NOT NULL,             -- argon2id
  full_name     text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'disabled')),
  is_owner      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

ALTER TABLE idn_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE idn_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idn_users
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Escape SOLO-SELECT para resolver el tenant en el login (ver rls.ts).
CREATE POLICY auth_lookup ON idn_users FOR SELECT
  USING (current_setting('app.auth_lookup', true) = 'on');

CREATE INDEX idx_users_tenant ON idn_users (tenant_id);
CREATE INDEX idx_users_email ON idn_users (email); -- lookup de login

-- ---------------------------------------------------------------------------
-- Roles y permisos con ámbito (RN-IDN-01)
-- Permiso = 'modulo.accion'. Ámbito en la asignación usuario-rol:
-- tenant | company | brand | location | kitchen (las entidades de organización
-- llegan en T3.12; scope_id queda nullable y sin FK hasta entonces).
-- ---------------------------------------------------------------------------
CREATE TABLE idn_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  code       text NOT NULL,                -- owner, admin, supervisor...
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
ALTER TABLE idn_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE idn_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idn_roles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_roles_tenant ON idn_roles (tenant_id);

CREATE TABLE idn_role_permissions (
  tenant_id  uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES idn_roles (id) ON DELETE CASCADE,
  permission text NOT NULL,                -- 'modulo.accion' o '*'
  PRIMARY KEY (tenant_id, role_id, permission)
);
ALTER TABLE idn_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE idn_role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idn_role_permissions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- `scope_id` es NULL cuando el ámbito es todo el tenant, así que no puede
-- formar parte de la clave primaria (una PK no admite NULL). Se usa una clave
-- subrogada y un índice único que normaliza el NULL con COALESCE, de modo que
-- la asignación sigue siendo única sin perder la semántica de "todo el tenant".
CREATE TABLE idn_user_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES idn_users (id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES idn_roles (id) ON DELETE CASCADE,
  scope_type text NOT NULL DEFAULT 'tenant'
             CHECK (scope_type IN ('tenant', 'company', 'brand', 'location', 'kitchen')),
  scope_id   uuid,                         -- NULL = todo el tenant
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_user_roles_unique ON idn_user_roles (
  tenant_id, user_id, role_id, scope_type,
  COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
ALTER TABLE idn_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE idn_user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idn_user_roles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_user_roles_user ON idn_user_roles (tenant_id, user_id);

-- ---------------------------------------------------------------------------
-- Sesiones: refresh rotativo con familias (RN-IDN-02).
-- Cada refresh emitido = una fila. Al rotar, la fila pasa a 'rotated' y nace
-- otra en la misma familia. Presentar un refresh 'rotated' = reuso → se revoca
-- la familia completa.
-- ---------------------------------------------------------------------------
CREATE TABLE idn_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES idn_users (id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  refresh_hash text NOT NULL,              -- sha256 del refresh token
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'rotated', 'revoked')),
  ip           text,
  user_agent   text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz
);
ALTER TABLE idn_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE idn_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idn_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE UNIQUE INDEX idx_sessions_refresh_hash ON idn_sessions (refresh_hash);
CREATE INDEX idx_sessions_family ON idn_sessions (tenant_id, family_id);
CREATE INDEX idx_sessions_user ON idn_sessions (tenant_id, user_id);
