-- 0018 — Analítica: proyección de rentabilidad por marca y canal
-- (spec 16, T4.29).
--
-- REVISAR SIEMPRE ESTE DIFF: de aquí sale el número que un dueño mira para
-- decidir si cierra una marca. La regla de la spec 16 es explícita y manda:
-- **el dashboard lee PROYECCIONES alimentadas por eventos, NUNCA las tablas
-- transaccionales en caliente.**
--
-- No es purismo arquitectónico. Un `GROUP BY` sobre `ord_orders` en hora punta
-- compite por las mismas filas que están cerrando pedidos: el panel se pone
-- lento y, peor, pone lenta la caja. Y un dueño mirando su rentabilidad a las
-- 20:30 de un viernes es exactamente el caso que hay que soportar.
--
-- Tres decisiones que definen la forma:
--
-- 1. **La granularidad es (día, marca, canal, local).** Es la pregunta que se
--    hace de verdad —«¿qué marca me da dinero y por qué canal?»— y cabe en una
--    fila por combinación. Guardar por pedido sería el mismo problema con otro
--    nombre.
--
-- 2. **Se guardan los SUMANDOS, no el margen.** El margen se calcula al leer.
--    Guardarlo calculado obliga a recalcular la fila entera cada vez que llega
--    un costo tardío, y abre la puerta a que el total y sus partes discrepen —
--    que es justo lo que la conciliación diaria de la spec debe detectar.
--
-- 3. **La fecha es la del NEGOCIO, no la UTC.** Un pedido de las 23:40 en Lima
--    es del día 7, no del 8. Guardar en UTC haría que el cierre de caja del
--    viernes y las ventas del viernes no cuadraran, y nadie sabría por qué.

CREATE TABLE ana_daily_sales (
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  -- Día de NEGOCIO en la zona del local (ver comentario 3).
  business_date date NOT NULL,
  brand_id      uuid NOT NULL,
  location_id   uuid NOT NULL,
  channel       text NOT NULL,

  orders        integer NOT NULL DEFAULT 0,
  -- Pedidos que no llegaron a venta. Se cuentan aparte para que no ensucien el
  -- ticket promedio: dividir ingresos entre pedidos incluyendo cancelados da
  -- un ticket más bajo que el real y lleva a decisiones equivocadas.
  cancelled     integer NOT NULL DEFAULT 0,

  -- Todos los sumandos, en NUMERIC(14,4) como el resto del sistema.
  gross_revenue NUMERIC(14,4) NOT NULL DEFAULT 0,
  discounts     NUMERIC(14,4) NOT NULL DEFAULT 0,
  delivery_fees NUMERIC(14,4) NOT NULL DEFAULT 0,
  tips          NUMERIC(14,4) NOT NULL DEFAULT 0,
  tax           NUMERIC(14,4) NOT NULL DEFAULT 0,
  -- Comisión del canal: estimada al aceptar, liquidada al conciliar
  -- (RN-BIL-04). Se guardan las dos y la diferencia es un dato de negocio.
  commission_estimated NUMERIC(14,4) NOT NULL DEFAULT 0,
  commission_settled   NUMERIC(14,4),
  -- Costo teórico de los insumos consumidos (viene del kardex de T4.25).
  food_cost     NUMERIC(14,4) NOT NULL DEFAULT 0,

  currency      text NOT NULL DEFAULT 'PEN',
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, business_date, brand_id, location_id, channel),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE,

  -- Los contadores no pueden ser negativos: si lo fueran, la proyección se
  -- habría desincronizado y el panel estaría mintiendo con cara de certeza.
  CONSTRAINT contadores_no_negativos CHECK (orders >= 0 AND cancelled >= 0)
);

ALTER TABLE ana_daily_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE ana_daily_sales FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ana_daily_sales
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_ana_daily_marca
  ON ana_daily_sales (tenant_id, brand_id, business_date DESC);
CREATE INDEX idx_ana_daily_canal
  ON ana_daily_sales (tenant_id, channel, business_date DESC);

-- ---------------------------------------------------------------------------
-- Qué pedidos ya están contados.
--
-- Sin esto, reprocesar un evento sumaría el mismo pedido dos veces y el panel
-- diría que se vendió el doble. El `inbox` del consumidor ya lo evita, pero un
-- reproceso manual —o un segundo consumidor añadido mañana— no pasa por él.
-- Aquí la garantía es de la tabla.
-- ---------------------------------------------------------------------------
CREATE TABLE ana_counted_orders (
  tenant_id    uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  order_id     uuid NOT NULL,
  -- Qué se contó ya de este pedido: la venta, el costo, la cancelación.
  fact         text NOT NULL,
  CONSTRAINT hecho_valido CHECK (fact IN ('sale','cost','cancellation')),
  business_date date NOT NULL,
  counted_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, order_id, fact),
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE ana_counted_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ana_counted_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ana_counted_orders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
