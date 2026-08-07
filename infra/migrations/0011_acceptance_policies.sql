-- 0011 — Aceptación automática/manual con vencimiento (RN-ORD-04) y ventana de
-- liberación de los pedidos programados (RN-ORD-05).
--
-- REVISAR SIEMPRE ESTE DIFF: cambia cuándo un pedido se acepta o se rechaza
-- SOLO, sin que nadie toque nada.
--
-- El problema de negocio: un pedido que llega y nadie acepta es peor que un
-- pedido rechazado. El cliente lo ve "en curso" en la app del marketplace, la
-- cocina no lo ve, y a los 40 minutos hay una reclamación y una penalización
-- del canal. La política dice, por (canal, marca), si se acepta solo y cuánto
-- se espera a una persona antes de avisar y antes de rendirse.

-- ---------------------------------------------------------------------------
-- Política de aceptación.
--
-- `brand_id` y `channel` NULL son COMODINES: NULL/NULL es la política por
-- defecto del tenant. Se resuelve por especificidad, igual que los precios del
-- catálogo (cat_prices), para no inventar un segundo mecanismo mental.
-- ---------------------------------------------------------------------------
CREATE TABLE ord_acceptance_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid,                      -- NULL = todas las marcas
  channel       text,                      -- NULL = todos los canales
  -- true: el pedido nace aceptado. Es lo normal en marketplaces, donde
  -- rechazar tiene coste de reputación y la decisión real es apagar el menú.
  auto_accept   boolean NOT NULL DEFAULT false,
  -- Minutos sin decisión humana antes de avisar. Solo alerta: no cambia nada.
  alert_after_minutes integer NOT NULL DEFAULT 5,
  -- Minutos sin decisión antes de rechazar solo y avisar al canal. Rendirse a
  -- tiempo es preferible a dejar al cliente esperando comida que nadie hará.
  auto_reject_after_minutes integer NOT NULL DEFAULT 10,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT alerta_antes_del_rechazo
    CHECK (alert_after_minutes <= auto_reject_after_minutes),
  CONSTRAINT plazos_positivos
    CHECK (alert_after_minutes > 0 AND auto_reject_after_minutes > 0)
);

ALTER TABLE ord_acceptance_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ord_acceptance_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ord_acceptance_policies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Una sola política por combinación. COALESCE porque una columna NULL no
-- participa en un índice único normal y "todas las marcas" es justamente NULL.
CREATE UNIQUE INDEX idx_acceptance_policy_scope
  ON ord_acceptance_policies (
    tenant_id,
    COALESCE(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(channel, '*')
  );

-- ---------------------------------------------------------------------------
-- Columnas de apoyo en el pedido.
-- ---------------------------------------------------------------------------

-- Momento en que se avisó de que llevaba demasiado sin aceptar. Sirve para que
-- el barrido no repita la alerta cada vuelta: sin esto, un pedido olvidado
-- generaría una notificación por minuto y el equipo aprendería a ignorarlas.
ALTER TABLE ord_orders ADD COLUMN acceptance_alerted_at timestamptz;

-- Tiempo de preparación vigente al crear el pedido. Se copia como el resto del
-- snapshot: si mañana se ajusta el prep_time del producto, la ventana de
-- liberación de un programado de ayer no debe moverse.
ALTER TABLE ord_orders ADD COLUMN prep_minutes integer NOT NULL DEFAULT 15;

-- El barrido de vencimientos busca pedidos sin aceptar por antigüedad; con
-- decenas de miles de pedidos cerrados, sin índice parcial haría un recorrido
-- completo cada vuelta.
CREATE INDEX idx_orders_pending_acceptance
  ON ord_orders (tenant_id, created_at)
  WHERE status = 'received';
