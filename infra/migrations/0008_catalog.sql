-- 0008 — Módulo Catalog (spec 04): categorías, productos, modificadores,
-- combos y listas de precios por canal.
--
-- REVISAR SIEMPRE ESTE DIFF: toca tenancy y DINERO.
--
-- Decisión central: **el precio no vive en el producto**, vive en una tabla de
-- precios con ámbito (marca, canal, local). El mismo pollo cuesta distinto en
-- la tienda propia que en un marketplace que cobra 25 % de comisión, y esa
-- diferencia es la palanca de rentabilidad del negocio. Modelarlo como un
-- campo del producto obligaría a duplicar productos por canal.
--
-- RN-CAT-01: resolución por prioridad (marca,canal,local) → (marca,canal) →
-- base. Sin precio para el canal, el producto NO se ve en ese canal: es
-- preferible que falte a que se venda a un precio inventado.
--
-- Dinero: NUMERIC(14,4), coherente con Money a escala 4 (ADR-0013).

-- ---------------------------------------------------------------------------
-- Categorías (jerarquía simple de un nivel para el MVP)
-- ---------------------------------------------------------------------------
CREATE TABLE cat_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id    uuid NOT NULL,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE cat_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cat_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cat_categories
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_categories_brand ON cat_categories (tenant_id, brand_id);

-- ---------------------------------------------------------------------------
-- Productos
--
-- `row_version` para control de concurrencia optimista (If-Match, docs/07 §6):
-- dos supervisores editando el mismo producto no se pisan en silencio.
-- ---------------------------------------------------------------------------
CREATE TABLE cat_products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid NOT NULL,
  category_id   uuid,
  sku           text,
  name          text NOT NULL,
  description   text,
  image_url     text,
  allergens     jsonb NOT NULL DEFAULT '[]'::jsonb,
  prep_minutes  integer NOT NULL DEFAULT 10,
  is_combo      boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  row_version   integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, category_id)
    REFERENCES cat_categories (tenant_id, id) ON DELETE SET NULL,
  CONSTRAINT prep_minutes_positivo CHECK (prep_minutes > 0)
);
ALTER TABLE cat_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE cat_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cat_products
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_products_brand ON cat_products (tenant_id, brand_id) WHERE active;
CREATE UNIQUE INDEX idx_products_sku ON cat_products (tenant_id, brand_id, sku)
  WHERE sku IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Grupos de modificadores y sus opciones (RN-CAT-05)
-- La validación de min/max vive en @sahana/domain; aquí se guarda la definición.
-- ---------------------------------------------------------------------------
CREATE TABLE cat_modifier_groups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id       uuid NOT NULL,
  name           text NOT NULL,
  min_selections integer NOT NULL DEFAULT 0,
  max_selections integer NOT NULL DEFAULT 1,
  allow_repeat   boolean NOT NULL DEFAULT false,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT modifier_min_no_negativo CHECK (min_selections >= 0),
  CONSTRAINT modifier_max_valido CHECK (max_selections >= 1),
  CONSTRAINT modifier_rango_coherente CHECK (max_selections >= min_selections)
);
ALTER TABLE cat_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE cat_modifier_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cat_modifier_groups
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE cat_modifier_options (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  group_id     uuid NOT NULL,
  name         text NOT NULL,
  -- Puede ser NEGATIVO: «sin papas» descuenta. Por eso no lleva CHECK >= 0.
  price_delta  NUMERIC(14,4) NOT NULL DEFAULT 0,
  available    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id)
    REFERENCES cat_modifier_groups (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE cat_modifier_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE cat_modifier_options FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cat_modifier_options
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_modifier_options_group ON cat_modifier_options (tenant_id, group_id);

-- Un grupo puede reutilizarse en varios productos (M:N).
CREATE TABLE cat_product_modifier_groups (
  tenant_id  uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  group_id   uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, product_id, group_id),
  FOREIGN KEY (tenant_id, product_id)
    REFERENCES cat_products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, group_id)
    REFERENCES cat_modifier_groups (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE cat_product_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE cat_product_modifier_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cat_product_modifier_groups
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Combos (RN-CAT-04): precio propio, pero el consumo de inventario se calcula
-- por COMPONENTES. Guardar solo el precio del combo perdería la trazabilidad
-- del costo, que es lo que permite saber si el combo es rentable.
-- ---------------------------------------------------------------------------
CREATE TABLE cat_combo_components (
  tenant_id      uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  combo_id       uuid NOT NULL,
  component_id   uuid NOT NULL,
  quantity       integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, combo_id, component_id),
  FOREIGN KEY (tenant_id, combo_id)
    REFERENCES cat_products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, component_id)
    REFERENCES cat_products (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT combo_cantidad_positiva CHECK (quantity > 0),
  -- Un combo que se contiene a sí mismo generaría recursión infinita al
  -- calcular su costo.
  CONSTRAINT combo_no_autorreferencia CHECK (combo_id <> component_id)
);
ALTER TABLE cat_combo_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE cat_combo_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cat_combo_components
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- PRECIOS POR ÁMBITO (RN-CAT-01) — el corazón de la rentabilidad por canal.
--
-- `channel` NULL = precio base (cualquier canal). `location_id` NULL = todos
-- los locales de la marca. La resolución elige el más específico disponible.
-- ---------------------------------------------------------------------------
CREATE TABLE cat_prices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  product_id  uuid NOT NULL,
  brand_id    uuid NOT NULL,
  channel     text,                       -- NULL = base; 'pos','web','whatsapp','rappi'...
  location_id uuid,                       -- NULL = todos los locales
  price       NUMERIC(14,4) NOT NULL,     -- incluye IGV (RN-T05)
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)
    REFERENCES cat_products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT precio_no_negativo CHECK (price >= 0)
);
ALTER TABLE cat_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE cat_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cat_prices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Un solo precio por combinación de ámbito. COALESCE normaliza los NULL para
-- que "base" y "todos los locales" participen de la unicidad.
CREATE UNIQUE INDEX idx_prices_scope ON cat_prices (
  tenant_id,
  product_id,
  COALESCE(channel, '*'),
  COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX idx_prices_lookup ON cat_prices (tenant_id, product_id) WHERE active;

-- ---------------------------------------------------------------------------
-- Disponibilidad y pausa (RN-CAT-03)
--
-- La pausa es por (producto, canal) y puede tener caducidad: «sin pollo hasta
-- las 8 de la noche» es la operación real de una cocina, no un borrado.
-- ---------------------------------------------------------------------------
CREATE TABLE cat_product_pauses (
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  product_id  uuid NOT NULL,
  channel     text NOT NULL DEFAULT '*',  -- '*' = todos los canales
  paused_at   timestamptz NOT NULL DEFAULT now(),
  until       timestamptz,                -- NULL = hasta reactivación manual
  reason      text,
  paused_by   uuid,
  PRIMARY KEY (tenant_id, product_id, channel),
  FOREIGN KEY (tenant_id, product_id)
    REFERENCES cat_products (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE cat_product_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE cat_product_pauses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cat_product_pauses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
