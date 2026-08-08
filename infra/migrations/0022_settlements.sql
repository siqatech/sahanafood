-- 0022 — Tarifario de canal y conciliación de liquidaciones (T5.07, RN-BIL-04).
--
-- Hasta aquí, `commission_estimated` estaba en `ord_orders` con DEFAULT 0 y
-- nadie lo escribía, y `commission_settled` en la proyección de analítica
-- esperando a alguien que nunca llegaba. El panel de rentabilidad restaba, en
-- la práctica, una comisión de cero: enseñaba el margen bruto llamándolo
-- margen. Esta migración pone las dos piezas que faltaban.
--
-- La regla es RN-BIL-04: **estimada al aceptar, liquidada al conciliar, y la
-- diferencia se reporta**. No se corrige la estimación con la liquidación
-- borrando la primera: las dos se guardan, porque la diferencia sistemática
-- entre ambas es lo que permite renegociar con el canal.

-- ---------------------------------------------------------------------------
-- TARIFARIO. Lo que el canal DICE que cobra.
-- ---------------------------------------------------------------------------
CREATE TABLE pay_channel_tariffs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  -- Canal de venta (`web`, `rappi`…) o pasarela: la comisión puede venir del
  -- marketplace, de la pasarela, o de ambos sumados.
  channel       text NOT NULL,
  provider      text,
  brand_id      uuid,

  -- Porcentaje en PUNTOS BÁSICOS, entero. Con 0.035 en coma flotante, mil
  -- pedidos acumulan una deriva que aparece justo en la conciliación y que
  -- nadie sabe explicar (ADR-0013).
  percent_bps   integer NOT NULL DEFAULT 0
                CHECK (percent_bps >= 0 AND percent_bps <= 10000),
  -- Cargo fijo y mínimo por transacción, en NUMERIC como todo el dinero.
  fixed_amount  numeric(14,4) NOT NULL DEFAULT 0 CHECK (fixed_amount >= 0),
  minimum_amount numeric(14,4) NOT NULL DEFAULT 0 CHECK (minimum_amount >= 0),
  currency      text NOT NULL DEFAULT 'PEN',

  -- Vigencia. Un tarifario que cambia NO reescribe lo ya estimado: se cierra el
  -- anterior y se abre uno nuevo. Sin esto, renegociar la comisión en marzo
  -- cambiaría el margen de enero, y el histórico dejaría de ser histórico.
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT vigencia_coherente
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

ALTER TABLE pay_channel_tariffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_channel_tariffs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_channel_tariffs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Una tarifa vigente por (canal, proveedor, marca). El COALESCE está porque en
-- SQL dos NULL no colisionan, y sin él un tenant acabaría con dos tarifas
-- «para todo» y estimaría con la que tocara.
CREATE UNIQUE INDEX idx_pay_tariffs_vigente
  ON pay_channel_tariffs (
    tenant_id, channel,
    COALESCE(provider, ''),
    COALESCE(brand_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------------
-- LIQUIDACIONES. Lo que el canal COBRÓ de verdad.
-- ---------------------------------------------------------------------------
CREATE TABLE pay_settlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  provider      text NOT NULL,
  -- Identificador del depósito en la pasarela. Único por tenant y proveedor:
  -- importar dos veces el mismo informe no puede duplicar las comisiones.
  external_ref  text NOT NULL,

  period_start  date NOT NULL,
  period_end    date NOT NULL,
  -- Bruto cobrado, comisiones retenidas y neto depositado, tal como los declara
  -- la pasarela. Se guardan los tres aunque neto = bruto − comisión: si NO
  -- cuadran, eso mismo es el hallazgo.
  gross_amount  numeric(14,4) NOT NULL,
  fee_amount    numeric(14,4) NOT NULL,
  net_amount    numeric(14,4) NOT NULL,
  currency      text NOT NULL DEFAULT 'PEN',
  deposited_at  timestamptz,

  status        text NOT NULL DEFAULT 'imported',
  CONSTRAINT estado_liquidacion_valido
    CHECK (status IN ('imported','reconciled','discrepant')),
  -- Resumen de la conciliación: cuántas líneas cuadraron y cuántas no.
  matched_lines   integer NOT NULL DEFAULT 0,
  unmatched_lines integer NOT NULL DEFAULT 0,
  missing_lines   integer NOT NULL DEFAULT 0,
  reconciled_at timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT periodo_coherente CHECK (period_end >= period_start)
);

ALTER TABLE pay_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_settlements
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Importar dos veces el mismo depósito no puede duplicar nada.
CREATE UNIQUE INDEX idx_pay_settlements_externo
  ON pay_settlements (tenant_id, provider, external_ref);

-- ---------------------------------------------------------------------------
-- LÍNEAS DE LIQUIDACIÓN. Una por transacción del informe.
-- ---------------------------------------------------------------------------
CREATE TABLE pay_settlement_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL,
  -- Referencia del cargo EN la pasarela. Es la clave con la que se casa contra
  -- `pay_intents.provider_ref`.
  provider_ref  text NOT NULL,
  intent_id     uuid,

  gross_amount  numeric(14,4) NOT NULL,
  fee_amount    numeric(14,4) NOT NULL,
  net_amount    numeric(14,4) NOT NULL,

  -- Cómo acabó esta línea al conciliar.
  --  matched    — se encontró el cobro y los importes cuadran.
  --  unmatched  — la pasarela cobró algo que aquí no consta. Es el hallazgo
  --               más serio: dinero movido sin pedido detrás.
  --  amount_mismatch — está el cobro pero el bruto no coincide.
  status        text NOT NULL DEFAULT 'pending',
  CONSTRAINT estado_linea_valido
    CHECK (status IN ('pending','matched','unmatched','amount_mismatch')),
  detail        text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_id)
    REFERENCES pay_settlements (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, intent_id)
    REFERENCES pay_intents (tenant_id, id) ON DELETE SET NULL
);

ALTER TABLE pay_settlement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_settlement_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_settlement_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- La misma transacción no puede aparecer dos veces en el mismo depósito.
CREATE UNIQUE INDEX idx_pay_settlement_lines_ref
  ON pay_settlement_lines (tenant_id, settlement_id, provider_ref);
CREATE INDEX idx_pay_settlement_lines_intent
  ON pay_settlement_lines (tenant_id, intent_id);

-- ---------------------------------------------------------------------------
-- La comisión liquidada, en el cobro.
-- ---------------------------------------------------------------------------
ALTER TABLE pay_intents
  ADD COLUMN commission_estimated numeric(14,4),
  ADD COLUMN commission_settled   numeric(14,4);
