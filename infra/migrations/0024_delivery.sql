-- 0024 — Delivery: repartidores, envíos y cobro contra entrega (spec 09,
-- T5.15–T5.17).
--
-- El envío es una entidad APARTE del pedido, con su propia máquina de estados.
-- Es la decisión que ordena toda la migración y merece explicarse, porque
-- meter cuatro columnas en `ord_orders` habría sido más rápido:
--
--  1. **Un reparto fallido no cancela el pedido** (RN-DLV-03). Se reintenta, o
--     se devuelve. Con los estados fundidos harían falta cosas como
--     `dispatched_failed_retrying`, y cocina tendría que entender de motos.
--  2. **Un pedido puede tener VARIOS intentos de entrega.** Una columna guarda
--     el último; una tabla guarda lo que pasó, que es lo que hace falta para
--     saber si un cliente falla siempre o fue una vez.
--  3. **El reparto del marketplace no es nuestro** (RN-DLV-04). Ahí el envío
--     solo registra el handoff: quién recogió y cuándo. Sin entidad propia, esa
--     fila serían más columnas nulas en el pedido.

-- ---------------------------------------------------------------------------
-- REPARTIDORES.
-- ---------------------------------------------------------------------------
CREATE TABLE dlv_couriers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  location_id   uuid NOT NULL,

  full_name     text NOT NULL,
  -- Nombre de pila, SEPARADO. El tracking público enseña este y solo este
  -- (criterio de aceptación de la spec 09): el cliente necesita saber a quién
  -- espera, no el apellido de nadie. Derivarlo del nombre completo en cada
  -- consulta es una fuga esperando a un apellido con espacios.
  first_name    text NOT NULL,
  phone         text,
  vehicle       text,
  CONSTRAINT vehiculo_valido
    CHECK (vehicle IS NULL OR vehicle IN ('moto','bici','auto','pie')),

  -- `available` / `busy` / `off`. `off` no entra en la asignación.
  status        text NOT NULL DEFAULT 'off',
  CONSTRAINT estado_repartidor_valido
    CHECK (status IN ('available','busy','off')),

  -- Usuario del sistema, si el repartidor entra a la app. Puede no tenerlo:
  -- muchos negocios empiezan con el encargado marcando las entregas.
  user_id       uuid,

  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE dlv_couriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlv_couriers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dlv_couriers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_dlv_couriers_local ON dlv_couriers (tenant_id, location_id)
  WHERE active;

-- ---------------------------------------------------------------------------
-- ZONAS QUE CUBRE CADA REPARTIDOR.
--
-- Tabla aparte y no un array: sin zonas declaradas, el repartidor cubre TODAS,
-- que es el caso del negocio de un local y tres motos. Un array obligaría a
-- distinguir «vacío» de NULL para decir lo mismo.
-- ---------------------------------------------------------------------------
CREATE TABLE dlv_courier_zones (
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  courier_id    uuid NOT NULL,
  zone_id       uuid NOT NULL,
  PRIMARY KEY (tenant_id, courier_id, zone_id),
  FOREIGN KEY (tenant_id, courier_id)
    REFERENCES dlv_couriers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, zone_id)
    REFERENCES org_zones (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE dlv_courier_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlv_courier_zones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dlv_courier_zones
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- ENVÍOS.
-- ---------------------------------------------------------------------------
CREATE TABLE dlv_shipments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  order_id      uuid NOT NULL,
  courier_id    uuid,
  zone_id       uuid,

  status        text NOT NULL DEFAULT 'pending',
  CONSTRAINT estado_envio_valido CHECK (status IN
    ('pending','assigned','picked_up','delivered','failed','returned','cancelled')),

  -- Reparto de un marketplace (RN-DLV-04): no es nuestro repartidor, solo se
  -- registra el handoff. Con courier externo, `courier_id` queda NULL.
  external_courier text,
  handoff_at    timestamptz,

  -- Cobro contra entrega (RN-DLV-02). NULL = ya está pagado.
  --
  -- NUMERIC(14,4) como todo el dinero del sistema. Se guarda aquí, y no se lee
  -- del pedido en cada consulta, porque es lo que el repartidor DEBE liquidar:
  -- si el pedido cambiara después, la deuda del repartidor cambiaría con él y
  -- el arqueo dejaría de cuadrar con lo que se cobró en la puerta.
  cod_amount    numeric(14,4) CHECK (cod_amount IS NULL OR cod_amount >= 0),
  cod_collected boolean NOT NULL DEFAULT false,
  -- La sesión de caja contra la que se liquidó. Mientras sea NULL, el dinero
  -- está en el bolsillo del repartidor.
  settled_session_id uuid,
  settled_at    timestamptz,

  -- Promesa al cliente. Alimenta la antigüedad de RN-DLV-01 y el ETA público.
  promised_at   timestamptz,
  eta_at        timestamptz,

  assigned_at   timestamptz,
  picked_up_at  timestamptz,
  delivered_at  timestamptz,
  failed_at     timestamptz,
  fail_reason   text,
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),

  -- Evidencia de entrega: foto, firma, quién recibió. JSONB porque cada
  -- negocio pide una cosa distinta y ninguna es obligatoria todavía.
  evidence      jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  -- UN envío vivo por pedido. El índice parcial de abajo lo garantiza sin
  -- impedir el histórico de intentos devueltos o cancelados.
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, courier_id)
    REFERENCES dlv_couriers (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, zone_id)
    REFERENCES org_zones (tenant_id, id) ON DELETE SET NULL,
  FOREIGN KEY (tenant_id, settled_session_id)
    REFERENCES cash_sessions (tenant_id, id) ON DELETE SET NULL,

  -- Asignado exige repartidor: un envío «asignado» sin nadie detrás es un
  -- pedido que la pantalla da por resuelto y que no va a salir.
  CONSTRAINT asignado_tiene_repartidor CHECK (
    status NOT IN ('assigned','picked_up','delivered')
      OR courier_id IS NOT NULL
      OR external_courier IS NOT NULL
  ),
  -- Fallar exige motivo. Sin él, la bandeja de fallos es una lista de pedidos
  -- rotos sin nada que hacer con ellos.
  CONSTRAINT fallo_tiene_motivo
    CHECK (status <> 'failed' OR fail_reason IS NOT NULL),
  -- Liquidado exige haber cobrado: marcar liquidado un cobro que no se hizo es
  -- un descuadre que aparece al cerrar caja y que nadie sabe explicar.
  CONSTRAINT liquidado_exige_cobro CHECK (
    settled_session_id IS NULL OR (cod_collected AND cod_amount IS NOT NULL)
  )
);

ALTER TABLE dlv_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlv_shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dlv_shipments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Un solo envío VIVO por pedido. Dos envíos activos del mismo pedido son dos
-- motos yendo a la misma puerta.
CREATE UNIQUE INDEX idx_dlv_shipments_vivo ON dlv_shipments (tenant_id, order_id)
  WHERE status IN ('pending','assigned','picked_up');

CREATE INDEX idx_dlv_shipments_cola ON dlv_shipments (tenant_id, status, promised_at)
  WHERE status IN ('pending','assigned','picked_up');

-- La carga de un repartidor: la consulta que ejecuta RN-DLV-01 en cada
-- asignación, y que en hora punta se ejecuta cada pocos segundos.
CREATE INDEX idx_dlv_shipments_carga ON dlv_shipments (tenant_id, courier_id)
  WHERE status IN ('assigned','picked_up');

-- Deuda pendiente de liquidar por repartidor (RN-DLV-02).
CREATE INDEX idx_dlv_shipments_por_liquidar
  ON dlv_shipments (tenant_id, courier_id)
  WHERE cod_collected AND settled_session_id IS NULL;
