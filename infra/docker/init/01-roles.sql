-- Roles de Sahana Food (docs/09-multi-tenancy.md §3, ADR-0002).
--
-- Regla innegociable: el rol de la APLICACIÓN no tiene BYPASSRLS ni es
-- superusuario. Si lo tuviera, la Row Level Security no lo afectaría y se
-- filtrarían datos entre tenants. Las migraciones corren con un rol separado
-- (dueño del esquema) para que el rol de app nunca sea propietario de tablas
-- (los propietarios saltan RLS salvo FORCE ROW LEVEL SECURITY, que igualmente
-- aplicamos en cada tabla).
--
-- Este script corre una sola vez, al inicializar el volumen de datos.

DO $$
BEGIN
  -- Rol de migraciones: dueño del esquema, crea/altera tablas.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahana_migrator') THEN
    CREATE ROLE sahana_migrator LOGIN PASSWORD 'sahana_migrator_dev'
      NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;

  -- Rol de aplicación (runtime): solo DML, sujeto a RLS.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahana_app') THEN
    CREATE ROLE sahana_app LOGIN PASSWORD 'sahana_app_dev'
      NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;

  -- Rol de soporte: consultas cross-tenant con motivo → audit_log (docs/09 §7).
  -- Se implementa en F3 sobre el mismo principio; aquí solo se reserva el rol.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahana_support') THEN
    CREATE ROLE sahana_support LOGIN PASSWORD 'sahana_support_dev'
      NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- El esquema public pertenece al migrador; el app solo usa lo que se le concede.
ALTER SCHEMA public OWNER TO sahana_migrator;
GRANT USAGE ON SCHEMA public TO sahana_app, sahana_support;

-- Privilegios por defecto: toda tabla/secuencia que cree el migrador otorga
-- DML al rol de app automáticamente (las migraciones no tienen que repetirlo).
ALTER DEFAULT PRIVILEGES FOR ROLE sahana_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sahana_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sahana_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sahana_app;

-- Soporte: solo lectura por defecto.
ALTER DEFAULT PRIVILEGES FOR ROLE sahana_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO sahana_support;

-- Parámetro de sesión que usará RLS: app.tenant_id. Se fija por transacción con
-- SET LOCAL (nunca a nivel de sesión, por el pooling en modo transacción).
