-- 0015 — Inventario: insumos, recetas y consumo automático (spec 08, T4.25).
--
-- REVISAR SIEMPRE ESTE DIFF: define el food cost, que es la cifra por la que un
-- restaurante gana o pierde dinero. Un error aquí no se ve en un log: se ve seis
-- meses después, en un plato que llevaba medio año vendiéndose por debajo de su
-- costo.
--
-- Cuatro decisiones que definen la forma:
--
-- 1. **El kardex es APPEND-ONLY y el stock es una materialización suya.**
--    Mismo criterio que `audit_log` y `cash_movements`: se revoca UPDATE y
--    DELETE al rol de aplicación. Un movimiento editable no sirve para explicar
--    por qué falta media caja de carne. La prueba de consistencia de la spec
--    compara la suma del kardex contra `inv_stock`, y solo tiene sentido si los
--    movimientos no se pueden retocar.
--
-- 2. **El stock NEGATIVO está permitido** (RN-INV-02). No hay CHECK que lo
--    impida y es deliberado: jamás se bloquea una venta por inventario. El
--    inventario de un restaurante siempre va por detrás de la realidad —nadie
--    registra la merma en hora punta—, así que un stock a cero es casi siempre
--    un dato viejo, no una despensa vacía. Se avisa; no se corta la venta.
--
-- 3. **La unidad vive en el INSUMO, no en la línea de receta.** Cada insumo se
--    guarda siempre en su unidad base y la conversión kg→g se hace al capturar.
--    Convertir en cada movimiento multiplica las ocasiones de equivocarse por
--    el número de movimientos.
--
-- 4. **El costo del movimiento es un SNAPSHOT** (RN-INV-04). Se copia el costo
--    vigente al consumir, no se referencia el del insumo: recalcular el food
--    cost histórico con los precios de hoy convierte un análisis de margen en
--    ficción.

-- ---------------------------------------------------------------------------
-- Almacenes: se EXTIENDE `org_warehouses` (0005), no se crea otra tabla.
--
-- Ya existía y su comentario decía justo esto: «el stock se consume a nivel
-- cocina/almacén». Una segunda tabla de almacenes habría partido el inventario
-- en dos mitades que se desincronizan en cuanto alguien dé de alta un almacén
-- por el sitio equivocado.
--
-- Solo le falta saber QUÉ COCINA consume de ella (RN-INV-01).
-- ---------------------------------------------------------------------------
ALTER TABLE org_warehouses
  ADD COLUMN kitchen_id uuid,
  ADD CONSTRAINT org_warehouses_cocina_fk
    FOREIGN KEY (tenant_id, kitchen_id)
    REFERENCES org_kitchens (tenant_id, id) ON DELETE SET NULL;

-- Una cocina consume de UN almacén: dos harían ambiguo de dónde descontar, y
-- la ambigüedad se resolvería sola, mal y en silencio.
CREATE UNIQUE INDEX idx_org_warehouses_cocina
  ON org_warehouses (tenant_id, kitchen_id)
  WHERE kitchen_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Insumos.
-- ---------------------------------------------------------------------------
CREATE TABLE inv_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,

  sku        text,
  name       text NOT NULL,

  -- Unidad BASE del insumo. Todo —recetas, stock, movimientos— se expresa
  -- aquí. Un insumo no cambia de unidad: cambiarla reinterpretaría todo el
  -- histórico del kardex sin tocar un solo número.
  unit       text NOT NULL,
  CONSTRAINT unidad_valida CHECK (unit IN ('g','ml','unit')),

  -- Costo unitario vigente (RN-INV-04: promedio móvil, recalculado en compra).
  -- NUMERIC(14,4) como todo el dinero del sistema.
  unit_cost  NUMERIC(14,4) NOT NULL DEFAULT 0,
  CONSTRAINT costo_no_negativo CHECK (unit_cost >= 0),

  -- Mínimo para alertar. NULL = no se vigila.
  min_stock  NUMERIC(14,4),

  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id)
);

ALTER TABLE inv_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inv_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX idx_inv_items_sku
  ON inv_items (tenant_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX idx_inv_items_nombre ON inv_items (tenant_id, name);

-- ---------------------------------------------------------------------------
-- Recetas y subrecetas.
-- ---------------------------------------------------------------------------
CREATE TABLE inv_recipes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,

  name          text NOT NULL,
  -- Producto que produce esta receta. NULL = subreceta (una salsa, una masa)
  -- que no se vende sola.
  product_id    uuid,

  -- Cuánto produce. Una salsa que rinde 2000 ml y se usa a 30 ml por plato
  -- consume 30/2000 de la receta, no una entera.
  yield_quantity NUMERIC(14,4) NOT NULL,
  yield_unit     text NOT NULL,
  CONSTRAINT rendimiento_positivo CHECK (yield_quantity > 0),
  CONSTRAINT unidad_rendimiento_valida CHECK (yield_unit IN ('g','ml','unit')),

  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)
    REFERENCES cat_products (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE inv_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_recipes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inv_recipes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Un producto tiene UNA receta activa. Dos harían indeterminado qué se
-- descuenta al venderlo, y el sistema elegiría una en silencio.
CREATE UNIQUE INDEX idx_inv_recipes_producto
  ON inv_recipes (tenant_id, product_id)
  WHERE product_id IS NOT NULL AND is_active;

CREATE TABLE inv_recipe_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  recipe_id    uuid NOT NULL,

  -- Apunta a un insumo o a otra receta (RN-INV-05, máx. 3 niveles).
  kind         text NOT NULL,
  CONSTRAINT tipo_componente_valido CHECK (kind IN ('item','recipe')),
  item_id      uuid,
  sub_recipe_id uuid,

  quantity     NUMERIC(14,4) NOT NULL,
  CONSTRAINT cantidad_positiva CHECK (quantity > 0),

  -- Merma en puntos básicos: 500 = 5 %. Es lo que se pierde al preparar —el
  -- recorte de la cebolla, lo que queda en la olla— y forma parte del consumo
  -- real: no contarla infla el margen teórico de cada plato.
  waste_bps    integer NOT NULL DEFAULT 0,
  CONSTRAINT merma_valida CHECK (waste_bps >= 0 AND waste_bps <= 100000),

  sort_order   integer NOT NULL DEFAULT 0,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, recipe_id)
    REFERENCES inv_recipes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id)
    REFERENCES inv_items (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, sub_recipe_id)
    REFERENCES inv_recipes (tenant_id, id) ON DELETE RESTRICT,

  -- El tipo y el destino tienen que concordar. Sin esto cabría una línea
  -- `kind='item'` con `item_id` nulo, que al estallar la receta desaparecería
  -- sin que nada avisara: el plato saldría consumiendo de menos.
  CONSTRAINT destino_concuerda_con_tipo CHECK (
    (kind = 'item'   AND item_id IS NOT NULL AND sub_recipe_id IS NULL) OR
    (kind = 'recipe' AND sub_recipe_id IS NOT NULL AND item_id IS NULL)
  ),
  -- Una receta que se contiene a sí misma es el ciclo más corto posible, y el
  -- único que la base puede cazar sola. Los ciclos largos los valida
  -- @sahana/domain al guardar.
  CONSTRAINT sin_autorreferencia CHECK (sub_recipe_id IS NULL OR sub_recipe_id <> recipe_id)
);

ALTER TABLE inv_recipe_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_recipe_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inv_recipe_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_inv_recipe_lines_receta
  ON inv_recipe_lines (tenant_id, recipe_id, sort_order);

-- ---------------------------------------------------------------------------
-- Stock materializado. Es un CACHÉ del kardex, y así hay que tratarlo: la
-- verdad son los movimientos.
-- ---------------------------------------------------------------------------
CREATE TABLE inv_stock (
  tenant_id    uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL,
  item_id      uuid NOT NULL,

  -- SIN restricción de no-negatividad, a propósito (RN-INV-02). Un CHECK aquí
  -- haría que una venta reventara la transacción del pedido por falta de
  -- stock, que es exactamente lo que la regla prohíbe.
  quantity     NUMERIC(14,4) NOT NULL DEFAULT 0,

  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, warehouse_id, item_id),
  FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES org_warehouses (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id)
    REFERENCES inv_items (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE inv_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_stock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inv_stock
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Para la alerta de mínimos y para el panel de stock por almacén.
CREATE INDEX idx_inv_stock_insumo ON inv_stock (tenant_id, item_id);

-- ---------------------------------------------------------------------------
-- Kardex. APPEND-ONLY.
-- ---------------------------------------------------------------------------
CREATE TABLE inv_movements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL,
  item_id      uuid NOT NULL,

  kind         text NOT NULL,
  CONSTRAINT tipo_movimiento_valido CHECK (
    kind IN ('consumption','reversal','waste','adjustment','purchase','transfer')
  ),

  -- CON SIGNO: negativo descuenta, positivo repone. A diferencia de
  -- `cash_movements` —donde el signo lo da el tipo— aquí conviven una reversa
  -- (+) y una merma (−) bajo tipos distintos, y un ajuste puede ir en
  -- cualquier dirección. Con importe siempre positivo haría falta una tabla de
  -- signos por tipo, y esa tabla es justo lo que se olvida actualizar al añadir
  -- un tipo nuevo.
  quantity     NUMERIC(14,4) NOT NULL,
  CONSTRAINT movimiento_no_nulo CHECK (quantity <> 0),

  -- Costo unitario VIGENTE al momento (RN-INV-04). Snapshot, no referencia:
  -- recalcular el food cost histórico con los precios de hoy convierte un
  -- análisis de margen en ficción.
  unit_cost    NUMERIC(14,4) NOT NULL DEFAULT 0,

  -- A qué pedido y a qué marca se atribuye el costo (RN-INV-01, docs/07 §3).
  -- Sin la marca, un local multimarca no puede saber cuál de sus marcas gana
  -- dinero, que es la pregunta que justifica la dark kitchen.
  order_id     uuid,
  brand_id     uuid,

  reason       text,
  actor_id     uuid,
  trace_id     text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES org_warehouses (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, item_id)
    REFERENCES inv_items (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE SET NULL,

  -- Un ajuste manual sin motivo es un descuadre sin explicación: cuando
  -- alguien pregunte por qué faltan 3 kg de carne, la respuesta será «alguien
  -- lo ajustó». Lo mismo la merma.
  CONSTRAINT ajuste_con_motivo CHECK (
    kind NOT IN ('adjustment','waste') OR reason IS NOT NULL
  )
);

ALTER TABLE inv_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inv_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inv_movements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_inv_movements_kardex
  ON inv_movements (tenant_id, warehouse_id, item_id, occurred_at);
CREATE INDEX idx_inv_movements_pedido
  ON inv_movements (tenant_id, order_id) WHERE order_id IS NOT NULL;
-- Para el food cost por marca de la analítica (T4.29).
CREATE INDEX idx_inv_movements_marca
  ON inv_movements (tenant_id, brand_id, occurred_at) WHERE brand_id IS NOT NULL;

-- Un pedido se consume UNA vez. Es la garantía de la BASE, no del código: el
-- consumidor de eventos puede recibir `order.accepted` dos veces (reintento de
-- BullMQ, republicación del relay), y sin este índice el segundo pase
-- descontaría el inventario por duplicado. El `inbox` ya lo evita, pero esto
-- lo hace estructuralmente imposible.
CREATE UNIQUE INDEX idx_inv_movements_consumo_unico
  ON inv_movements (tenant_id, order_id, item_id)
  WHERE kind = 'consumption' AND order_id IS NOT NULL;

-- Append-only: mismo criterio que audit_log y cash_movements. Un kardex
-- editable no explica nada — quien se lleva media caja de carne lo primero que
-- hace es corregir el registro.
REVOKE UPDATE, DELETE ON inv_movements FROM sahana_app;
