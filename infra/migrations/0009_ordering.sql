-- 0009 — Módulo Ordering (spec 05, canónica): el orquestador de pedidos.
--
-- REVISAR SIEMPRE ESTE DIFF: toca tenancy, DINERO y auditoría.
--
-- Tres decisiones estructurales que este esquema hace cumplir a nivel de base
-- de datos, no de código:
--
-- 1. **SNAPSHOT INMUTABLE** (RN-ORD-02, RN-T02). Las líneas guardan el nombre,
--    el precio y el impuesto que estaban vigentes al confirmar. Si mañana sube
--    el precio del pollo, el pedido de ayer no cambia — y el comprobante ya
--    emitido sigue cuadrando. Por eso las líneas NO tienen FK a `cat_prices`:
--    referenciar el precio actual destruiría el snapshot.
--
-- 2. **DEDUPE POR CANAL** (RN-ORD-03). Índice único (tenant, channel,
--    external_ref). Que un marketplace reintente su webhook es normal, no una
--    excepción; la unicidad la garantiza la BD y no el orden de llegada.
--
-- 3. **TIMELINE COMPLETO** (§11.3). Cada transición deja una fila en
--    `ord_order_events`. Poder responder «qué le pasó a este pedido» es un
--    requisito de soporte, no un lujo de auditoría.

-- ---------------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------------
CREATE TABLE ord_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id       uuid NOT NULL,
  location_id    uuid NOT NULL,
  -- Número legible para el cliente y para la cocina («pedido 42»).
  order_number   integer NOT NULL,
  channel        text NOT NULL,             -- pos | web | whatsapp | rappi...
  -- Referencia del canal externo; NULL en canales propios.
  external_ref   text,
  status         text NOT NULL DEFAULT 'received',
  CONSTRAINT estado_valido CHECK (status IN (
    'received','needs_review','scheduled','accepted','preparing','ready',
    'packed','dispatched','delivered','picked_up','rejected','cancelled'
  )),

  -- Cliente (denormalizado a propósito: el pedido debe poder leerse aunque el
  -- cliente se borre por derecho al olvido; el vínculo va en customer_id).
  customer_id    uuid,
  customer_name  text,
  customer_phone text,
  delivery_address text,
  delivery_lat   double precision,
  delivery_lng   double precision,
  zone_id        uuid,

  -- TOTALES: salida de @sahana/domain, jamás recalculados en SQL (spec 05 §3).
  subtotal       NUMERIC(14,4) NOT NULL,
  discount_total NUMERIC(14,4) NOT NULL DEFAULT 0,
  delivery_fee   NUMERIC(14,4) NOT NULL DEFAULT 0,
  tip            NUMERIC(14,4) NOT NULL DEFAULT 0,
  total          NUMERIC(14,4) NOT NULL,
  taxable_base   NUMERIC(14,4) NOT NULL,
  tax            NUMERIC(14,4) NOT NULL,
  tax_rate_bps   integer NOT NULL DEFAULT 1800,
  currency       text NOT NULL DEFAULT 'PEN',
  -- Comisión ESTIMADA del canal al confirmar (RN-T09). La liquidada llega
  -- después y se compara: la diferencia es un dato de negocio, no un error.
  commission_estimated NUMERIC(14,4) NOT NULL DEFAULT 0,

  scheduled_at   timestamptz,               -- RN-ORD-05
  promised_at    timestamptz,               -- RN-ORD-08
  accepted_at    timestamptz,
  closed_at      timestamptz,
  cancel_reason  text,
  notes          text,

  row_version    integer NOT NULL DEFAULT 1, -- If-Match (RN-ORD-07)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT total_no_negativo CHECK (total >= 0),
  CONSTRAINT subtotal_no_negativo CHECK (subtotal >= 0)
);
ALTER TABLE ord_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ord_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ord_orders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- DEDUPE (RN-ORD-03): la unicidad la impone la BD. Dos workers procesando el
-- mismo webhook a la vez no pueden crear dos pedidos, pase lo que pase.
CREATE UNIQUE INDEX idx_orders_external_ref
  ON ord_orders (tenant_id, channel, external_ref)
  WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX idx_orders_number ON ord_orders (tenant_id, order_number);
CREATE INDEX idx_orders_status ON ord_orders (tenant_id, status, created_at DESC);
CREATE INDEX idx_orders_brand ON ord_orders (tenant_id, brand_id, created_at DESC);
CREATE INDEX idx_orders_location ON ord_orders (tenant_id, location_id, created_at DESC);
-- La bandeja de excepciones se consulta constantemente: índice parcial.
CREATE INDEX idx_orders_exceptions ON ord_orders (tenant_id, created_at)
  WHERE status = 'needs_review';
-- Los programados se liberan por un job que barre por fecha.
CREATE INDEX idx_orders_scheduled ON ord_orders (tenant_id, scheduled_at)
  WHERE status = 'scheduled';

-- Numerador por tenant. Se usa con SELECT ... FOR UPDATE para que dos pedidos
-- simultáneos no reciban el mismo número.
CREATE TABLE ord_counters (
  tenant_id    uuid PRIMARY KEY REFERENCES ten_tenants (id) ON DELETE CASCADE,
  next_number  integer NOT NULL DEFAULT 1
);
ALTER TABLE ord_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ord_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ord_counters
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Líneas del pedido — SNAPSHOT INMUTABLE (RN-ORD-02)
--
-- `product_name` y `unit_price` se copian, no se referencian. Un cambio de
-- catálogo no puede reescribir un pedido confirmado.
-- ---------------------------------------------------------------------------
CREATE TABLE ord_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  order_id      uuid NOT NULL,
  -- Referencia informativa al producto; el snapshot manda para el importe.
  product_id    uuid,
  product_name  text NOT NULL,             -- snapshot
  quantity      integer NOT NULL,
  unit_price    NUMERIC(14,4) NOT NULL,    -- snapshot
  modifiers_total NUMERIC(14,4) NOT NULL DEFAULT 0,
  discount      NUMERIC(14,4) NOT NULL DEFAULT 0,
  line_total    NUMERIC(14,4) NOT NULL,
  -- Modificadores elegidos, con su nombre y precio del momento.
  modifiers     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Línea de ajuste por modificación posterior (RN-ORD-07): nunca se reescribe
  -- una línea confirmada, se añade otra.
  is_adjustment boolean NOT NULL DEFAULT false,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT cantidad_positiva CHECK (quantity > 0),
  CONSTRAINT precio_unitario_no_negativo CHECK (unit_price >= 0)
);
ALTER TABLE ord_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ord_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ord_order_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_order_lines_order ON ord_order_lines (tenant_id, order_id);

-- ---------------------------------------------------------------------------
-- Timeline (spec 05 §11.3): toda transición deja rastro.
-- Append-only como `audit_log`: el histórico de un pedido no se reescribe.
-- ---------------------------------------------------------------------------
CREATE TABLE ord_order_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  order_id     uuid NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  event        text NOT NULL,              -- accept | start_preparing | ...
  from_status  text,
  to_status    text NOT NULL,
  actor_type   text NOT NULL DEFAULT 'system',
  actor_id     text,
  reason       text,
  trace_id     text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,

  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE ord_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ord_order_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ord_order_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_order_events_order ON ord_order_events (tenant_id, order_id, occurred_at);
-- El timeline no se reescribe: mismo criterio que audit_log.
REVOKE UPDATE, DELETE ON ord_order_events FROM sahana_app;

-- ---------------------------------------------------------------------------
-- Claves de idempotencia (ADR-0010) para POST de clientes propios.
--
-- Se guarda el HASH del payload: repetir la misma clave con el MISMO cuerpo
-- devuelve la respuesta original; con un cuerpo DISTINTO es un error del
-- cliente (422), no una segunda creación silenciosa.
-- ---------------------------------------------------------------------------
CREATE TABLE ord_idempotency_keys (
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  key           text NOT NULL,
  payload_hash  text NOT NULL,
  order_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key),
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE ord_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE ord_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ord_idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
