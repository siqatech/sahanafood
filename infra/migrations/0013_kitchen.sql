-- 0013 — Cocina / KDS (spec 07, T4.16).
--
-- REVISAR SIEMPRE ESTE DIFF: es donde el pedido deja de ser una fila y se
-- convierte en comida. Un fallo aquí no se ve en un panel: se ve en una cocina
-- que no sabe qué preparar.
--
-- Hasta ahora todo el flujo terminaba en un estado de base de datos que nadie
-- miraba. El ticket es la unidad de trabajo REAL: lo que un cocinero tiene
-- delante en su estación, con solo las líneas que le tocan a él.
--
-- Tres decisiones que explican la forma:
--
-- 1. **Un ticket POR ESTACIÓN, no por pedido** (RN-KIT-01). El de la parrilla
--    no necesita ver las bebidas y el de armado no necesita ver el pollo hasta
--    que esté hecho. Mandar el pedido entero a todas las pantallas obliga a
--    cada cocinero a filtrar mentalmente lo suyo, que es exactamente el trabajo
--    que el KDS existe para quitar.
--
-- 2. **El ticket lleva SNAPSHOT de sus líneas.** Igual que `ord_order_lines`:
--    el nombre y las cantidades se copian. Si alguien modifica el catálogo
--    mientras el pedido está en la plancha, lo que el cocinero ve no cambia
--    debajo de sus manos.
--
-- 3. **Unicidad (pedido, estación).** El consumidor del evento `order.accepted`
--    se ejecuta al menos una vez (ADR-0007). Que un reintento no duplique
--    tickets lo garantiza este índice, no el código: dos tickets del mismo
--    pedido en la misma pantalla significan comida cocinada dos veces.

-- ---------------------------------------------------------------------------
-- Tipo de estación, para poder enrutar producto → estación.
--
-- Es un texto libre acordado por el tenant (`grill`, `fry`, `assembly`,
-- `drinks`...) y no un enum: cada operación organiza su cocina distinto, y un
-- enum obligaría a una migración cada vez que alguien añade una plancha.
-- ---------------------------------------------------------------------------
ALTER TABLE org_stations ADD COLUMN kind text;
CREATE INDEX idx_stations_kind ON org_stations (tenant_id, kitchen_id, kind);

-- Estación a la que va cada producto. NULL = va a la estación por defecto de
-- la cocina, que es lo correcto para un negocio que empieza con una sola.
ALTER TABLE cat_products ADD COLUMN station_kind text;

-- ---------------------------------------------------------------------------
-- Tickets de cocina
-- ---------------------------------------------------------------------------
CREATE TABLE kit_tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  order_id      uuid NOT NULL,
  kitchen_id    uuid NOT NULL,
  station_id    uuid NOT NULL,
  -- Marca del pedido. Denormalizada a propósito: la pantalla y la etiqueta la
  -- necesitan en cada refresco, y RN-KIT-03 exige verificarla al empacar.
  brand_id      uuid NOT NULL,

  status        text NOT NULL DEFAULT 'pending',
  CONSTRAINT estado_ticket_valido
    CHECK (status IN ('pending','in_progress','ready','cancelled')),

  -- Número visible del pedido: el cocinero canta «42 listo», no un uuid.
  order_number  integer NOT NULL,
  -- Copia del compromiso con el cliente. La cola del KDS se ordena por esto y
  -- no por hora de llegada: un programado que entra tarde puede ser lo más
  -- urgente de la pantalla.
  promised_at   timestamptz,

  started_at    timestamptz,
  ready_at      timestamptz,
  row_version   integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, kitchen_id)
    REFERENCES org_kitchens (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, station_id)
    REFERENCES org_stations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE kit_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kit_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kit_tickets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Un solo ticket por (pedido, estación): el consumidor de eventos es
-- at-least-once y esto es lo que impide cocinar dos veces.
CREATE UNIQUE INDEX idx_tickets_pedido_estacion
  ON kit_tickets (tenant_id, order_id, station_id);
-- La consulta que hace el KDS cada pocos segundos: cola de MI estación,
-- ordenada por compromiso. Índice parcial porque lo cerrado no se muestra.
CREATE INDEX idx_tickets_cola
  ON kit_tickets (tenant_id, station_id, promised_at)
  WHERE status IN ('pending','in_progress');
CREATE INDEX idx_tickets_order ON kit_tickets (tenant_id, order_id);

-- ---------------------------------------------------------------------------
-- Líneas del ticket — SNAPSHOT, igual que las del pedido.
-- ---------------------------------------------------------------------------
CREATE TABLE kit_ticket_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  ticket_id      uuid NOT NULL,
  -- Referencia informativa; el snapshot manda para lo que se cocina.
  order_line_id  uuid,
  product_name   text NOT NULL,
  quantity       integer NOT NULL,
  -- Modificadores en texto ya resuelto: «Grande, sin papas». El cocinero no
  -- tiene que interpretar ids a las 21:00 con veinte pedidos encima.
  modifiers_text text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id)
    REFERENCES kit_tickets (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT cantidad_ticket_positiva CHECK (quantity > 0)
);

ALTER TABLE kit_ticket_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE kit_ticket_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kit_ticket_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX idx_ticket_lines_ticket ON kit_ticket_lines (tenant_id, ticket_id);
