-- 0012 — Publicación versionada del catálogo (spec 04, T4.06).
--
-- REVISAR SIEMPRE ESTE DIFF: define lo que el POS offline y los canales
-- consideran «el catálogo», incluidos sus PRECIOS.
--
-- Por qué una tabla de versiones y no leer siempre el catálogo vivo:
--
-- 1. **El POS offline necesita algo estable.** Vende sin red durante horas
--    contra lo que descargó. Si eso fuera «lo último que hubiera», dos cajas
--    del mismo local podrían estar cobrando precios distintos sin saberlo.
--
-- 2. **Publicar no puede bloquear ventas** (criterio de aceptación). Por eso la
--    publicación solo INSERTA una fila nueva: no toca `cat_products` ni
--    `cat_prices`, no toma cerrojos sobre ellos, y un pedido en curso sigue
--    resolviendo su precio sin esperar a nadie.
--
-- 3. **Una versión publicada es inmutable.** Es la referencia para reconstruir
--    qué se ofrecía el martes a las 20:00 cuando un cliente reclame. Se revoca
--    UPDATE y DELETE al rol de aplicación, igual que en `audit_log`: si el
--    código intentara reescribirla, falla en la base y no en una revisión.

CREATE TABLE cat_catalog_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid NOT NULL,
  channel       text NOT NULL,
  -- Correlativo POR (marca, canal): «la versión 7 de la web de Marca A» es una
  -- referencia que una persona puede decir por teléfono.
  version       integer NOT NULL,

  -- Instantánea completa y ya resuelta: precios del canal aplicados, pausas
  -- aplicadas, modificadores incluidos. El cliente NO recalcula nada.
  snapshot      jsonb NOT NULL,
  -- Huella del contenido comparable. Republicar sin cambios reales devuelve la
  -- versión existente en vez de crear otra idéntica: sin esto, un botón de
  -- «publicar» pulsado tres veces genera tres versiones que la PWA se
  -- descargaría creyendo que algo cambió.
  checksum      text NOT NULL,
  product_count integer NOT NULL,

  published_at  timestamptz NOT NULL DEFAULT now(),
  published_by  uuid,
  notes         text,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT version_positiva CHECK (version > 0)
);

ALTER TABLE cat_catalog_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cat_catalog_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cat_catalog_versions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Dos publicaciones simultáneas no pueden reclamar el mismo número: la
-- unicidad la impone la base, no el orden en que lleguen.
CREATE UNIQUE INDEX idx_catalog_versions_numero
  ON cat_catalog_versions (tenant_id, brand_id, channel, version);
-- La consulta habitual es «dame la última de este canal».
CREATE INDEX idx_catalog_versions_ultima
  ON cat_catalog_versions (tenant_id, brand_id, channel, version DESC);

-- Inmutable: mismo criterio que audit_log y ord_order_events.
REVOKE UPDATE, DELETE ON cat_catalog_versions FROM sahana_app;
