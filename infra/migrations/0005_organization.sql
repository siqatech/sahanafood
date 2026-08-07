-- 0005 — Módulo Organization (spec 03): empresas, marcas, locales, cocinas,
-- estaciones, almacenes, zonas de cobertura y horarios.
--
-- REVISAR SIEMPRE ESTE DIFF: toca tenancy y dinero.
--
-- Dos decisiones estructurales visibles aquí:
--
-- 1. **FKs COMPUESTAS con tenant_id** (docs/09 §4). Cada tabla lleva
--    `UNIQUE (tenant_id, id)` y las relaciones referencian ese par, no solo el
--    id. Efecto: la base de datos hace imposible que una fila apunte a un padre
--    de OTRO tenant, incluso si un bug de la aplicación lo intentara. La RLS
--    filtra lo que se ve; esto además impide construir la relación cruzada.
--
-- 2. **Polígonos como GeoJSON en jsonb**, no PostGIS (ADR-0015). El cálculo de
--    cobertura vive en @sahana/domain para que tienda, agente IA, POS offline y
--    servidor den la misma respuesta. Se guarda el bounding box precalculado
--    para poder pre-filtrar en SQL cuando el volumen lo pida.
--
-- Dinero: NUMERIC(14,4), coherente con la escala interna de Money (ADR-0013).

-- ---------------------------------------------------------------------------
-- Empresas (razón social y RUC; emiten los comprobantes)
-- ---------------------------------------------------------------------------
CREATE TABLE org_companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  legal_name  text NOT NULL,
  tax_id      text NOT NULL,                     -- RUC en Perú
  address     text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),                        -- habilita FKs compuestas
  UNIQUE (tenant_id, tax_id)
);
ALTER TABLE org_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_companies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_companies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_companies_tenant ON org_companies (tenant_id);

-- ---------------------------------------------------------------------------
-- Marcas (lo que ve el cliente: nombre comercial, slug, dominio propio)
-- ---------------------------------------------------------------------------
CREATE TABLE org_brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  company_id  uuid NOT NULL,
  name        text NOT NULL,
  slug        text NOT NULL,
  domain      text,                              -- dominio propio de la tienda
  branding    jsonb NOT NULL DEFAULT '{}'::jsonb,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, company_id)
    REFERENCES org_companies (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE org_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_brands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_brands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_brands_tenant ON org_brands (tenant_id);
-- El dominio es único globalmente: dos tenants no pueden reclamar el mismo host.
CREATE UNIQUE INDEX idx_brands_domain ON org_brands (domain) WHERE domain IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Locales (dirección física; su zona horaria manda para horarios y cierres)
-- ---------------------------------------------------------------------------
CREATE TABLE org_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  company_id  uuid NOT NULL,
  name        text NOT NULL,
  address     text NOT NULL,
  lat         double precision,
  lng         double precision,
  timezone    text NOT NULL DEFAULT 'America/Lima',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id)
    REFERENCES org_companies (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE org_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_locations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_locations_tenant ON org_locations (tenant_id);

-- ---------------------------------------------------------------------------
-- Cocinas (una o varias por local; producen para varias marcas)
-- ---------------------------------------------------------------------------
CREATE TABLE org_kitchens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE org_kitchens ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_kitchens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_kitchens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_kitchens_tenant ON org_kitchens (tenant_id);

-- ---------------------------------------------------------------------------
-- Marca ⟷ Cocina: M:N (RN-ORG-01, docs/07 §1).
-- NUNCA se anida la marca dentro del local: una cocina produce para varias
-- marcas y una marca se produce en varias cocinas. Es el corazón del modelo
-- multimarca de dark kitchen.
-- ---------------------------------------------------------------------------
CREATE TABLE org_brand_kitchens (
  tenant_id  uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id   uuid NOT NULL,
  kitchen_id uuid NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, brand_id, kitchen_id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, kitchen_id)
    REFERENCES org_kitchens (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE org_brand_kitchens ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_brand_kitchens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_brand_kitchens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_brand_kitchens_kitchen ON org_brand_kitchens (tenant_id, kitchen_id);

-- ---------------------------------------------------------------------------
-- Estaciones (plancha, frituras, armado…): el KDS enruta tickets por estación
-- ---------------------------------------------------------------------------
CREATE TABLE org_stations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  kitchen_id  uuid NOT NULL,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, kitchen_id)
    REFERENCES org_kitchens (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE org_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_stations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_stations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_stations_kitchen ON org_stations (tenant_id, kitchen_id);

-- ---------------------------------------------------------------------------
-- Almacenes (el stock se consume a nivel cocina/almacén — docs/07 §3)
-- ---------------------------------------------------------------------------
CREATE TABLE org_warehouses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE org_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_warehouses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_warehouses_tenant ON org_warehouses (tenant_id);

-- ---------------------------------------------------------------------------
-- Zonas de cobertura (RN-ORG-02)
--
-- El polígono se guarda como anillo GeoJSON `[[lng,lat], ...]` en jsonb. El
-- bounding box va precalculado y con índice: permite descartar zonas en SQL sin
-- evaluar el polígono, si algún día un tenant tiene cientos de zonas.
-- Se permite el SOLAPAMIENTO: gana la de menor tarifa (resuelto en el dominio).
-- ---------------------------------------------------------------------------
CREATE TABLE org_zones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid,                            -- NULL = aplica a todas las marcas
  location_id   uuid NOT NULL,                   -- local que la atiende
  name          text NOT NULL,
  polygon       jsonb NOT NULL,                  -- [[lng,lat], ...]
  min_lng       double precision NOT NULL,
  min_lat       double precision NOT NULL,
  max_lng       double precision NOT NULL,
  max_lat       double precision NOT NULL,
  delivery_fee  NUMERIC(14,4) NOT NULL DEFAULT 0,
  min_order     NUMERIC(14,4) NOT NULL DEFAULT 0,
  base_minutes  integer NOT NULL DEFAULT 30,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT zone_fee_no_negativa CHECK (delivery_fee >= 0),
  CONSTRAINT zone_min_no_negativo CHECK (min_order >= 0),
  CONSTRAINT zone_minutos_positivos CHECK (base_minutes > 0),
  CONSTRAINT zone_bbox_coherente CHECK (min_lng <= max_lng AND min_lat <= max_lat)
);
ALTER TABLE org_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_zones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_zones
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_zones_tenant_brand ON org_zones (tenant_id, brand_id) WHERE active;
CREATE INDEX idx_zones_bbox ON org_zones (tenant_id, min_lng, max_lng, min_lat, max_lat);

-- ---------------------------------------------------------------------------
-- Horarios (RN-ORG-03): por (marca, local, canal), con excepciones por fecha.
-- `weekly` = [{weekday, opensAt, closesAt}], `exceptions` = [{date, ranges}].
-- La evaluación (incluido el cruce de medianoche) vive en @sahana/domain.
-- ---------------------------------------------------------------------------
CREATE TABLE org_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id    uuid,                              -- NULL = todas las marcas
  location_id uuid NOT NULL,
  channel     text,                              -- NULL = todos los canales
  weekly      jsonb NOT NULL DEFAULT '[]'::jsonb,
  exceptions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE org_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_schedules
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Un solo horario por combinación; COALESCE normaliza los NULL de "todas/todos".
CREATE UNIQUE INDEX idx_schedules_unique ON org_schedules (
  tenant_id,
  location_id,
  COALESCE(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(channel, '*')
);
