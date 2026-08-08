#!/usr/bin/env bash
#
# Roles de Sahana Food (docs/09-multi-tenancy.md §3, ADR-0002).
#
# Es un SCRIPT y no un `.sql` por una razón concreta: las contraseñas venían
# escritas dentro del archivo. En desarrollo daba igual; en un servidor de
# verdad significaba que el rol de aplicación —el que lee todos los pedidos de
# todos los clientes— tenía una contraseña publicada en el repositorio. Ahora
# vienen del entorno, y el `docker-compose.prod.yml` las exige.
#
# Corre en dos sitios, y por eso lee la conexión del entorno:
#  · Dentro del contenedor de Postgres, al CREAR el volumen (entrypoint).
#  · Desde CI o desde una máquina, con `PGHOST`/`PGPASSWORD` puestos.
#
# Los valores por defecto son los de desarrollo, y solo sirven ahí: el compose
# de producción no los define, así que si faltan, falla al levantar en vez de
# crear un rol con una contraseña conocida.
set -euo pipefail

APP_PASSWORD="${SAHANA_APP_PASSWORD:-sahana_app_dev}"
MIGRATOR_PASSWORD="${SAHANA_MIGRATOR_PASSWORD:-sahana_migrator_dev}"
SUPPORT_PASSWORD="${SAHANA_SUPPORT_PASSWORD:-sahana_support_dev}"

sql=$(cat <<'SQL'
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
    CREATE ROLE sahana_migrator LOGIN PASSWORD '__MIGRATOR_PASSWORD__'
      NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;

  -- Rol de aplicación (runtime): solo DML, sujeto a RLS.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahana_app') THEN
    CREATE ROLE sahana_app LOGIN PASSWORD '__APP_PASSWORD__'
      NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
  END IF;

  -- Rol de soporte: consultas cross-tenant con motivo → audit_log (docs/09 §7).
  -- Se implementa en F3 sobre el mismo principio; aquí solo se reserva el rol.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahana_support') THEN
    CREATE ROLE sahana_support LOGIN PASSWORD '__SUPPORT_PASSWORD__'
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

SQL
)

# Sustitución fuera del SQL: así el cuerpo va entre comillas simples y ni una
# variable se expande por accidente dentro de una sentencia.
sql="${sql//__APP_PASSWORD__/$APP_PASSWORD}"
sql="${sql//__MIGRATOR_PASSWORD__/$MIGRATOR_PASSWORD}"
sql="${sql//__SUPPORT_PASSWORD__/$SUPPORT_PASSWORD}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER:-${PGUSER:-sahana}}" \
  --dbname "${POSTGRES_DB:-${PGDATABASE:-sahana}}" \
  <<<"$sql"
