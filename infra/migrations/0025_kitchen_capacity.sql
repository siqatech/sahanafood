-- 0025 — Capacidad y saturación de cocina (RN-KIT-04, spec 07, T5.18).
--
-- Paga **DT-03**, aceptada en F4 con vencimiento en F5. Lo que estaba sin
-- resolver: el KDS no limitaba cuántos pedidos aceptaba, así que en hora punta
-- la cocina admitía más de lo que podía producir. No fallaba nada —los pedidos
-- entraban, la caja cobraba, el KDS los pintaba—; simplemente todos salían
-- tarde, y el cliente se enteraba después de pagar.

-- ---------------------------------------------------------------------------
-- POLÍTICA DE CAPACIDAD, por cocina.
--
-- Por COCINA y no por local: en una dark kitchen dos marcas comparten fogones,
-- y lo que satura son los fogones, no la marca. Poner el límite en el local
-- daría un número que no corresponde a ninguna cola real.
-- ---------------------------------------------------------------------------
CREATE TABLE kit_capacity (
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  kitchen_id    uuid NOT NULL,

  -- Primer umbral: por encima se extienden las promesas, pero SE SIGUE
  -- VENDIENDO. Es la mitad que más importa: un cliente al que le dicen 55 min
  -- no se va; uno al que le prometen 35 y llega en 55, sí.
  max_concurrent_items integer NOT NULL DEFAULT 20
    CHECK (max_concurrent_items > 0),
  extend_minutes integer NOT NULL DEFAULT 15
    CHECK (extend_minutes > 0),

  -- Segundo umbral: por encima se pausan canales. NULL = nunca se pausa solo,
  -- que es la configuración de quien prefiere decidirlo a mano.
  pause_threshold_items integer
    CHECK (pause_threshold_items IS NULL OR pause_threshold_items > 0),

  -- Canales en el ORDEN en que se pausan: el primero es el de menor margen.
  --
  -- Lista explícita y no un cálculo sobre la comisión vigente. Podría
  -- derivarse —más comisión, menos margen—, pero entonces renegociar una
  -- tarifa en marzo cambiaría en silencio qué canal se cierra en hora punta.
  -- Eso es una decisión de negocio que el dueño tiene que ver y poder cambiar;
  -- la API la SUGIERE a partir de las comisiones, no la impone.
  channel_pause_order text[] NOT NULL DEFAULT '{}',

  -- Nivel vigente, para no repetir el efecto en cada evaluación y para que el
  -- KDS lo pinte sin recalcular.
  level         text NOT NULL DEFAULT 'normal',
  CONSTRAINT nivel_valido CHECK (level IN ('normal','saturated','critical')),
  level_since   timestamptz,

  enabled       boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, kitchen_id),
  FOREIGN KEY (tenant_id, kitchen_id)
    REFERENCES org_kitchens (tenant_id, id) ON DELETE CASCADE,

  -- El segundo umbral tiene que estar POR ENCIMA del primero. Al revés, la
  -- cocina pasaría de normal a cerrar canales sin avisar por el camino.
  CONSTRAINT pausa_por_encima_de_saturacion CHECK (
    pause_threshold_items IS NULL
      OR pause_threshold_items > max_concurrent_items
  ),
  -- Con umbral de pausa hace falta saber qué se pausa.
  CONSTRAINT pausa_exige_orden CHECK (
    pause_threshold_items IS NULL OR cardinality(channel_pause_order) > 0
  )
);

ALTER TABLE kit_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE kit_capacity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kit_capacity
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- HISTÓRICO DE SATURACIÓN.
--
-- Append-only de hecho: cada cambio de nivel deja su fila. Sirve para dos
-- preguntas que un dueño hace de verdad —«¿cuántas veces cerramos Rappi el mes
-- pasado?» y «¿a qué hora nos saturamos?»— y que sin histórico se responden a
-- ojo. También es lo que permite discutir si el umbral está bien puesto en vez
-- de moverlo por sensación.
-- ---------------------------------------------------------------------------
CREATE TABLE kit_saturation_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  kitchen_id    uuid NOT NULL,
  from_level    text NOT NULL,
  to_level      text NOT NULL,
  active_items  integer NOT NULL,
  channels_paused text[] NOT NULL DEFAULT '{}',
  orders_extended integer NOT NULL DEFAULT 0,
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, kitchen_id)
    REFERENCES org_kitchens (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE kit_saturation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kit_saturation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON kit_saturation_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_kit_saturation_historico
  ON kit_saturation_events (tenant_id, kitchen_id, created_at DESC);
