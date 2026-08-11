-- 0033 — Claves publicables de tienda (ADR-0020).
--
-- Identifican una MARCA desde el navegador. Van en el HTML de la web del
-- cliente, así que son públicas por diseño y eso cambia cómo se guardan
-- respecto a cualquier otro secreto del sistema:
--
--  · **Se guardan en claro.** Las credenciales de conector se cifran y los PIN
--    se hashean porque son secretos; esta no lo es. Hashearla impediría
--    enseñársela al dueño en el panel —que es su único uso— sin ganar nada:
--    está publicada en la web del cliente.
--  · **Lo que la protege no es el secreto, es lo poco que abre**: leer el
--    catálogo, que ya es público, y operar sobre el carrito que ella misma crea.
--    Más el CORS, acotado a los dominios que el cliente registró.
--
-- Por eso tampoco hay `audit_log` al usarla: se usa en cada carga de la carta de
-- cada visitante. Lo que sí se audita es emitirla y revocarla.
CREATE TABLE sto_publishable_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id    uuid NOT NULL,

  -- `pk_` + 32 hex. El prefijo es deliberado: hace que la clave se reconozca a
  -- simple vista en un pegado de código y, sobre todo, que se distinga de un
  -- token de sesión. Lo que se busca evitar es que alguien publique en su web
  -- lo que NO es publicable creyendo que sí.
  key         text NOT NULL,

  -- Un nombre para el humano: «web nueva», «landing de fiestas». Con dos claves
  -- vivas, revocar la que no era es cuestión de saber cuál es cuál.
  label       text NOT NULL DEFAULT 'Web del cliente',

  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Se revoca, no se borra: una clave borrada deja de explicar por qué una web
  -- dejó de funcionar de golpe.
  revoked_at  timestamptz,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE
);

-- La búsqueda por clave es la del camino caliente —cada visita a una tienda de
-- tercero pasa por aquí— y es GLOBAL: quien llama solo trae la clave, todavía no
-- sabemos de qué tenant es. Único en todo el sistema, no por tenant.
CREATE UNIQUE INDEX idx_clave_publicable ON sto_publishable_keys (key);

ALTER TABLE sto_publishable_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE sto_publishable_keys FORCE ROW LEVEL SECURITY;

-- Aislamiento normal por tenant para el panel.
-- `NULLIF` antes del casteo, como el resto del esquema: dentro de la resolución
-- pública el parámetro está VACÍO, y `''::uuid` no devuelve «ninguna fila»,
-- revienta la consulta entera con un 500.
CREATE POLICY tenant_aislado ON sto_publishable_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Y la escapatoria acotada para resolver la clave ANTES de saber el tenant, que
-- es el mismo patrón que usa `sto_domains` para resolver el host (ADR-0017).
-- Solo lectura, y solo cuando el proceso declara que está en esa resolución.
CREATE POLICY resolucion_publica ON sto_publishable_keys
  FOR SELECT
  USING (current_setting('app.public_token', true) = 'on');

GRANT SELECT, INSERT, UPDATE ON sto_publishable_keys TO sahana_app;
