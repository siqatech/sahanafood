-- 0014 — Caja: sesiones, movimientos y arqueo (spec 06, T4.17/T4.18).
--
-- REVISAR SIEMPRE ESTE DIFF: toca DINERO EN EFECTIVO y auditoría. Es la parte
-- del sistema donde un fallo no se descubre en un log sino en una caja que no
-- cuadra al final del turno, con un cajero delante que no sabe qué pasó.
--
-- Tres decisiones que definen la forma:
--
-- 1. **La sesión es el contenedor de responsabilidad.** Un turno tiene un
--    responsable, un fondo inicial y un conteo final. Sin sesión no se vende
--    (RN-POS-01): un cobro sin sesión es dinero que entra sin que nadie
--    responda por él, y aparece como descuadre de otro turno.
--
-- 2. **Los movimientos son APPEND-ONLY.** Igual que `audit_log`: se revoca
--    UPDATE y DELETE al rol de aplicación. Un movimiento que se puede editar
--    no sirve para arquear — quien se lleva dinero de la caja lo primero que
--    hace es corregir el registro.
--
-- 3. **El importe esperado NO se guarda: se calcula.** Es la suma de los
--    movimientos en efectivo más el fondo. Guardarlo abriría la puerta a que
--    el total y sus partes discrepen, que es exactamente el error que un
--    arqueo debe detectar.

CREATE TABLE cash_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  location_id   uuid NOT NULL,
  -- Terminal física. Dos cajas del mismo local llevan sesiones separadas.
  device_id     uuid,
  -- Quién responde del dinero de este turno.
  opened_by     uuid NOT NULL,
  closed_by     uuid,

  status        text NOT NULL DEFAULT 'open',
  CONSTRAINT estado_sesion_valido CHECK (status IN ('open','closing','closed')),

  -- Fondo con el que arranca el turno (RN-POS-02).
  opening_float NUMERIC(14,4) NOT NULL DEFAULT 0,
  -- Lo que el cajero DECLARA haber contado al cerrar. NULL mientras esté abierta.
  declared_cash NUMERIC(14,4),
  -- Lo que el sistema esperaba: fondo + entradas − salidas. Se congela al
  -- cerrar para poder auditar el arqueo tal como se hizo, aunque después
  -- llegue un movimiento tardío.
  expected_cash NUMERIC(14,4),
  -- declared − expected. Positivo = sobra dinero; negativo = falta.
  difference    NUMERIC(14,4),
  difference_reason text,
  -- Supervisor que autorizó cerrar con diferencia (RN-POS-02).
  approved_by   uuid,

  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  notes         text,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fondo_no_negativo CHECK (opening_float >= 0),
  -- Una sesión cerrada tiene que traer las tres cifras del arqueo. Sin esto,
  -- un cierre a medias produciría una sesión "cerrada" que no cuadra con nada.
  CONSTRAINT cierre_completo CHECK (
    status <> 'closed'
    OR (declared_cash IS NOT NULL AND expected_cash IS NOT NULL
        AND difference IS NOT NULL AND closed_at IS NOT NULL)
  ),
  -- Cerrar con diferencia exige motivo Y aprobación (RN-POS-02). Lo impone la
  -- base: es la regla que más tentador resulta saltarse a las 23:00.
  CONSTRAINT diferencia_justificada CHECK (
    status <> 'closed'
    OR difference = 0
    OR (difference_reason IS NOT NULL AND approved_by IS NOT NULL)
  )
);

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- UNA sesión abierta por terminal. Dos sesiones abiertas en la misma caja
-- hacen imposible saber a cuál pertenece un cobro, y el descuadre aparece al
-- cerrar la primera. La unicidad la impone la base, no el orden de llegada.
CREATE UNIQUE INDEX idx_cash_sessions_abierta_por_device
  ON cash_sessions (tenant_id, device_id)
  WHERE status <> 'closed' AND device_id IS NOT NULL;
-- Y una por (local, responsable) cuando no hay terminal asignada.
CREATE UNIQUE INDEX idx_cash_sessions_abierta_sin_device
  ON cash_sessions (tenant_id, location_id, opened_by)
  WHERE status <> 'closed' AND device_id IS NULL;
CREATE INDEX idx_cash_sessions_local
  ON cash_sessions (tenant_id, location_id, opened_at DESC);

-- ---------------------------------------------------------------------------
-- Movimientos de caja — APPEND-ONLY
-- ---------------------------------------------------------------------------
CREATE TABLE cash_movements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  session_id   uuid NOT NULL,

  kind         text NOT NULL,
  CONSTRAINT tipo_movimiento_valido
    CHECK (kind IN ('sale','refund','cash_in','cash_out','tip')),

  -- Medio de pago. Solo `cash` afecta al conteo físico; el resto se registra
  -- para cuadrar el turno completo, no la gaveta.
  method       text NOT NULL DEFAULT 'cash',
  CONSTRAINT metodo_valido
    CHECK (method IN ('cash','card','wallet','transfer','other')),

  -- SIEMPRE positivo; el signo lo da el tipo. Un importe negativo mezclado con
  -- un tipo de salida da un doble negativo que nadie ve hasta el arqueo.
  amount       NUMERIC(14,4) NOT NULL,
  CONSTRAINT importe_positivo CHECK (amount > 0),

  order_id     uuid,
  actor_id     uuid,
  reason       text,
  trace_id     text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES cash_sessions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE SET NULL
);

ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_movements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_cash_movements_sesion
  ON cash_movements (tenant_id, session_id, occurred_at);
-- Un pedido cobrado no se cobra dos veces en la misma caja.
CREATE UNIQUE INDEX idx_cash_movements_venta_unica
  ON cash_movements (tenant_id, order_id)
  WHERE kind = 'sale' AND order_id IS NOT NULL;

-- Append-only: mismo criterio que audit_log y ord_order_events. Un movimiento
-- editable no sirve para arquear.
REVOKE UPDATE, DELETE ON cash_movements FROM sahana_app;
