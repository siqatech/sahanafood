-- 0010 — Plataforma de integraciones (spec 13) + simulador de marketplace.
--
-- REVISAR SIEMPRE ESTE DIFF: toca tenancy, credenciales y el camino de ingesta
-- de pedidos externos.
--
-- La regla que este esquema hace cumplir es una sola, y es la que decide si el
-- negocio funciona: **un webhook que respondimos 202 no se pierde nunca**
-- (spec 05 §11.1, RN-INT-02). Todo lo demás se deriva de ahí:
--
-- 1. `int_webhook_events` es la ZONA DE ATERRIZAJE DURABLE. El endpoint valida
--    la firma, escribe la fila y responde. No mapea catálogo, no calcula
--    precios, no toca `ord_*`. Si el proceso muere justo después del ack, el
--    payload ya está en disco y otro worker lo recoge (RN-INT-01, < 250 ms).
--
-- 2. El worker reclama con FOR UPDATE SKIP LOCKED dentro de una transacción.
--    Si muere a mitad, el ROLLBACK libera el cerrojo y la fila vuelve a estar
--    disponible: no hace falta un temporizador de lease ni un barrido de
--    zombis. La idempotencia del pedido la garantiza el índice único
--    (tenant, channel, external_ref) de la 0009, no el orden de llegada.
--
-- 3. Un fallo de mapeo NO es un descarte: termina en un pedido `needs_review`
--    (RN-ORD-10). Por eso `order_id` se llena tanto en el camino feliz como en
--    el de excepción, y `status='failed'` queda reservado para lo que ni
--    siquiera pudo apartarse — que la prueba de caos exige que sea CERO.

-- ---------------------------------------------------------------------------
-- Conexiones por tenant.
--
-- Las credenciales van CIFRADAS campo a campo con clave derivada por tenant
-- (RN-INT-04, ver integrations/app/credential-cipher.ts). En BD solo hay
-- ciphertext: quien lea un backup no obtiene el secreto de firma de nadie.
--
-- `webhook_token` es distinto del secreto: es el identificador PÚBLICO que va
-- en la URL del webhook. Es opaco y rotable, y por sí solo no autoriza nada —
-- la firma HMAC sigue siendo obligatoria.
-- ---------------------------------------------------------------------------
CREATE TABLE int_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  provider      text NOT NULL,             -- simulator | rappi | pedidosya...
  brand_id      uuid NOT NULL,
  location_id   uuid NOT NULL,
  -- Canal con el que entran los pedidos de esta conexión (ord_orders.channel).
  channel       text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  CONSTRAINT estado_conexion_valido CHECK (status IN ('active','paused','disabled')),

  webhook_token text NOT NULL,
  credentials   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- cifrado campo a campo
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Circuit breaker por conexión (RN-INT-03): desactivar un proveedor no puede
  -- arrastrar a los demás, así que el estado vive en la fila del proveedor.
  consecutive_failures integer NOT NULL DEFAULT 0,
  circuit_opened_at    timestamptz,
  last_success_at      timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, brand_id, location_id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE int_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE int_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON int_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Escape SOLO-SELECT, mismo patrón acotado que `app.auth_lookup` (ADR-0014):
-- el webhook de un marketplace llega SIN token propio, así que el tenant se
-- resuelve a partir del webhook_token de la URL antes de tener contexto. Es
-- lectura, es una sola tabla, y todo lo posterior pasa por withTenant.
CREATE POLICY integration_lookup ON int_connections FOR SELECT
  USING (current_setting('app.integration_lookup', true) = 'on');

-- El token identifica la conexión globalmente: la unicidad no puede ser por
-- tenant, porque el tenant es justamente lo que se está resolviendo.
CREATE UNIQUE INDEX idx_int_connections_token ON int_connections (webhook_token);
CREATE INDEX idx_int_connections_tenant ON int_connections (tenant_id, provider);

-- ---------------------------------------------------------------------------
-- Mapeo de catálogo externo ↔ interno.
--
-- Un SKU sin fila aquí es un fallo de mapeo, y un fallo de mapeo NUNCA es un
-- descarte (RN-INT-02): el pedido va a la bandeja de excepciones con su payload
-- para que alguien lo resuelva y lo reprocese.
-- ---------------------------------------------------------------------------
CREATE TABLE int_catalog_map (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  external_sku  text NOT NULL,
  -- Exactamente uno de los dos: el SKU externo es un producto o una opción.
  product_id           uuid,
  modifier_option_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES int_connections (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)
    REFERENCES cat_products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, modifier_option_id)
    REFERENCES cat_modifier_options (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT mapea_uno_u_otro CHECK (
    (product_id IS NOT NULL) <> (modifier_option_id IS NOT NULL)
  )
);

ALTER TABLE int_catalog_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE int_catalog_map FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON int_catalog_map
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX idx_int_catalog_map_sku
  ON int_catalog_map (tenant_id, connection_id, external_sku);

-- ---------------------------------------------------------------------------
-- Zona de aterrizaje de webhooks. Es infraestructura de eventos, igual que
-- outbox/inbox, y por eso comparte su escape `app.system`: el worker reclama
-- cross-tenant. Ninguna tabla de NEGOCIO consulta ese flag.
--
-- `delivery_id` es el identificador del INTENTO de entrega del proveedor; dos
-- reintentos del mismo pedido traen delivery_id distinto y external_ref igual.
-- Por eso el dedupe de verdad (un solo pedido) lo hace `ord_orders`, no esta
-- tabla: aquí solo se evita procesar dos veces el MISMO envío.
-- ---------------------------------------------------------------------------
CREATE TABLE int_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  provider      text NOT NULL,
  delivery_id   text NOT NULL,
  -- Referencia del pedido en el canal; puede ser NULL si el payload venía roto.
  external_ref  text,
  event_type    text NOT NULL DEFAULT 'order.created',
  -- Payload CRUDO tal cual llegó. Es la única fuente para reprocesar, así que
  -- se guarda antes de intentar entenderlo.
  payload       jsonb NOT NULL,
  headers       jsonb NOT NULL DEFAULT '{}'::jsonb,

  status        text NOT NULL DEFAULT 'pending',
  CONSTRAINT estado_webhook_valido CHECK (status IN ('pending','done','failed')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  -- Pedido resultante: el del camino feliz o el apartado a needs_review. Que
  -- esté NULL con status='done' sería una pérdida silenciosa; lo impide el
  -- CHECK de abajo.
  order_id      uuid,
  trace_id      text,

  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES int_connections (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE SET NULL,
  -- La invariante de «cero pérdida», escrita donde no se puede saltar: nada se
  -- da por terminado sin un pedido detrás.
  CONSTRAINT hecho_implica_pedido CHECK (status <> 'done' OR order_id IS NOT NULL)
);

ALTER TABLE int_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE int_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_system ON int_webhook_events
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  );

-- Un mismo envío no se procesa dos veces.
CREATE UNIQUE INDEX idx_int_webhook_delivery
  ON int_webhook_events (tenant_id, provider, delivery_id);
-- El worker barre lo pendiente por antigüedad, cross-tenant.
CREATE INDEX idx_int_webhook_pending ON int_webhook_events (received_at)
  WHERE status = 'pending';
CREATE INDEX idx_int_webhook_tenant
  ON int_webhook_events (tenant_id, received_at DESC);
-- La cola de muertos se revisa a mano: debe estar vacía.
CREATE INDEX idx_int_webhook_failed ON int_webhook_events (tenant_id, received_at)
  WHERE status = 'failed';
