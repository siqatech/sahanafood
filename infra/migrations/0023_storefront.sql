-- 0023 — Tienda web (spec 11, T5.08–T5.13).
--
-- El carrito vive en el SERVIDOR, no en el navegador. Es la decisión que
-- ordena toda la tabla y merece explicarse, porque la alternativa —carrito en
-- localStorage, se envía entero al confirmar— es más fácil y es la que usa
-- media internet:
--
--  1. **RN-STO-02 exige validar al agregar Y al confirmar.** Un carrito que
--     solo existe en el cliente no se puede revalidar: llega al checkout con
--     precios de hace veinte minutos y productos que se agotaron mientras el
--     cliente decidía.
--  2. **«Pago fallido → carrito recuperable»** es criterio de aceptación de la
--     spec. Un carrito en el navegador se pierde al cerrar la pestaña, que es
--     justo lo que hace la gente cuando le rebotan la tarjeta.
--  3. El precio lo pone el servidor. Siempre. Un carrito de cliente es una
--     lista de deseos, no una factura.

-- ---------------------------------------------------------------------------
-- DOMINIOS. Qué marca sirve cada host (RN-STO-03).
-- ---------------------------------------------------------------------------
CREATE TABLE sto_domains (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid NOT NULL,
  -- Host completo en minúsculas: `pollos.com`, `marca.sahana.food`.
  host          text NOT NULL,
  -- true = subdominio nuestro; false = dominio propio del tenant con CNAME.
  is_subdomain  boolean NOT NULL DEFAULT true,

  -- Verificación del CNAME. Un dominio propio sin verificar NO sirve la tienda:
  -- serviría el catálogo de una marca en un host que aún no es suyo, y eso es
  -- exactamente cómo se secuestra una tienda.
  verified_at   timestamptz,
  verification_token text,

  status        text NOT NULL DEFAULT 'pending',
  CONSTRAINT estado_dominio_valido
    CHECK (status IN ('pending','active','disabled')),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  -- Un dominio activo tiene que estar verificado. La regla en la base y no en
  -- el servicio: es la que impide servir la marca A en el host de B.
  CONSTRAINT activo_exige_verificado
    CHECK (status <> 'active' OR verified_at IS NOT NULL)
);

ALTER TABLE sto_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE sto_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sto_domains
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- El host llega en la cabecera de una petición sin sesión: resolverlo es el
-- paso previo a saber de quién es la tienda. Se reutiliza `app.public_token`
-- (ADR-0017) en vez de crear un sexto escape — la tabla no tiene datos de
-- negocio, solo el mapa host → marca.
CREATE POLICY public_host_lookup ON sto_domains FOR SELECT
  USING (current_setting('app.public_token', true) = 'on');

-- El host es único GLOBALMENTE: es lo que hace imposible que dos tenants
-- reclamen el mismo dominio, y por tanto lo que hace imposible el secuestro.
CREATE UNIQUE INDEX idx_sto_domains_host ON sto_domains (lower(host));

-- ---------------------------------------------------------------------------
-- CARRITOS. En el servidor, con su token público.
-- ---------------------------------------------------------------------------
CREATE TABLE sto_carts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid NOT NULL,
  -- Se resuelve por la zona de la dirección (RN-STO-01) y puede cambiar si el
  -- cliente cambia de dirección a mitad de compra.
  location_id   uuid,
  zone_id       uuid,

  status        text NOT NULL DEFAULT 'open',
  CONSTRAINT estado_carrito_valido
    CHECK (status IN ('open','ordered','abandoned')),

  fulfillment   text NOT NULL DEFAULT 'delivery',
  CONSTRAINT entrega_valida CHECK (fulfillment IN ('delivery','pickup')),

  -- Datos del invitado. Mínimos (RN-STO-04): lo que hace falta para entregar la
  -- comida y nada más.
  customer_name  text,
  customer_phone text,
  address        text,
  address_lat    double precision,
  address_lng    double precision,
  notes          text,

  -- Consentimiento de marketing SEPARADO y explícito (RN-T10, Ley 29733). No
  -- es una casilla dentro de «acepto los términos»: es su propia decisión, y se
  -- guarda el texto exacto que se aceptó porque un booleano no demuestra qué
  -- aceptó nadie.
  marketing_consent boolean NOT NULL DEFAULT false,
  marketing_consent_text text,
  marketing_consent_at timestamptz,

  coupon_code   text,
  order_id      uuid,

  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE SET NULL,
  -- Un carrito convertido tiene su pedido. Sin esto, `ordered` sin pedido sería
  -- una venta que el sistema cree hecha y que no existe.
  CONSTRAINT convertido_tiene_pedido
    CHECK (status <> 'ordered' OR order_id IS NOT NULL),
  CONSTRAINT consentimiento_tiene_texto
    CHECK (marketing_consent = false OR marketing_consent_text IS NOT NULL)
);

ALTER TABLE sto_carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sto_carts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sto_carts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_sto_carts_abiertos ON sto_carts (expires_at)
  WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- LÍNEAS DEL CARRITO.
--
-- NO guardan precio. Es deliberado y es lo contrario de `ord_order_lines`, que
-- sí congela el suyo: un carrito es una lista de deseos y el precio se resuelve
-- del catálogo vigente en cada consulta, de modo que un cambio de precio se ve
-- ANTES de pagar y no después. El pedido, en cambio, es un contrato: ahí el
-- precio se congela para siempre (RN-ORD-02).
-- ---------------------------------------------------------------------------
CREATE TABLE sto_cart_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  cart_id       uuid NOT NULL,
  product_id    uuid NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  modifier_option_ids uuid[] NOT NULL DEFAULT '{}',
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, cart_id)
    REFERENCES sto_carts (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE sto_cart_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sto_cart_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sto_cart_lines
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_sto_cart_lines_carrito ON sto_cart_lines (tenant_id, cart_id);

-- ---------------------------------------------------------------------------
-- CUPONES (v1).
-- ---------------------------------------------------------------------------
CREATE TABLE sto_coupons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid,
  code          text NOT NULL,

  kind          text NOT NULL,
  CONSTRAINT tipo_cupon_valido
    CHECK (kind IN ('percent','fixed','free_delivery')),
  -- Porcentaje en PUNTOS BÁSICOS enteros, como todo porcentaje del sistema.
  percent_bps   integer CHECK (percent_bps IS NULL OR (percent_bps >= 0 AND percent_bps <= 10000)),
  amount        numeric(14,4) CHECK (amount IS NULL OR amount >= 0),
  min_order     numeric(14,4) NOT NULL DEFAULT 0 CHECK (min_order >= 0),
  max_discount  numeric(14,4) CHECK (max_discount IS NULL OR max_discount >= 0),

  valid_from    timestamptz,
  valid_until   timestamptz,
  max_uses      integer CHECK (max_uses IS NULL OR max_uses > 0),
  -- Contador de usos. Se incrementa con el pedido EN LA MISMA transacción: un
  -- contador que se actualiza después deja pasar cien usos de un cupón de uno.
  used_count    integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  active        boolean NOT NULL DEFAULT true,

  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  -- Cada tipo necesita su dato: un `percent` sin porcentaje descontaría cero y
  -- el cliente vería un cupón que «funciona» sin descontar nada.
  CONSTRAINT datos_coherentes_con_tipo CHECK (
    (kind = 'percent' AND percent_bps IS NOT NULL) OR
    (kind = 'fixed' AND amount IS NOT NULL) OR
    (kind = 'free_delivery')
  )
);

ALTER TABLE sto_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE sto_coupons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sto_coupons
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX idx_sto_coupons_codigo
  ON sto_coupons (tenant_id, upper(code));

-- El propósito del token del carrito, que reutiliza `pub_tokens` (ADR-0017).
ALTER TABLE pub_tokens DROP CONSTRAINT proposito_valido;
ALTER TABLE pub_tokens ADD CONSTRAINT proposito_valido
  CHECK (purpose IN ('payment_link','order_tracking','cart'));
