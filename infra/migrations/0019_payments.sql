-- 0019 — Pagos online (spec 10 parte F5, ADR-0010, ADR-0016).
--
-- La regla que ordena todo este esquema es RN-PAY-01: **un pedido online se
-- confirma SOLO con webhook de pago verificado, nunca con el redirect del
-- navegador**. El redirect lo controla el cliente —se pega en la barra de
-- direcciones, se reproduce, y llega antes de que la pasarela sepa si el cargo
-- prosperó—, así que aquí no existe ni como columna.

-- ---------------------------------------------------------------------------
-- CONEXIONES DE PASARELA. Credenciales por tenant, nunca en claro.
--
-- Tabla aparte de `int_connections` a propósito: una pasarela de pago y un
-- canal de venta se listan, se pausan y se auditan por separado, y meterlas
-- juntas haría que la bandeja de canales mostrara pasarelas (ADR-0016).
-- ---------------------------------------------------------------------------
CREATE TABLE pay_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  provider      text NOT NULL,          -- culqi, mercadopago, simulador…
  -- Opcional: un tenant puede cobrar todo con la misma cuenta o separar por
  -- marca. NULL = vale para todas las marcas del tenant.
  brand_id      uuid,

  -- Token público de la URL de callback. 32 bytes en base64url: la pasarela lo
  -- tiene configurado, y es lo ÚNICO que permite averiguar de quién es el aviso
  -- antes de poder verificar su firma (ADR-0016 §1).
  webhook_token text NOT NULL,
  -- Credenciales cifradas con clave derivada por tenant (RN-INT-04). Aquí vive
  -- el secreto de firma del webhook y las claves de API.
  credentials   jsonb NOT NULL DEFAULT '{}'::jsonb,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,

  status        text NOT NULL DEFAULT 'active',
  CONSTRAINT estado_conexion_pago_valido
    CHECK (status IN ('active','paused','disabled')),

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE pay_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pay_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Escape acotado SOLO-SELECT, cuarto del sistema (ADR-0016, extiende ADR-0014).
-- La pasarela avisa sin ningún token nuestro: lo único que trae es el
-- `webhook_token` de la URL, y resolver la conexión es el paso PREVIO a poder
-- verificar la firma. Resolver no autoriza: devuelve el secreto para comprobar
-- el HMAC, y una firma inválida se rechaza sin tocar el pago.
--
-- Nótese qué tabla lleva el escape: ESTA, que guarda credenciales. NUNCA
-- `pay_intents`, que guarda importes. Esa es la línea que hace que el patrón
-- siga siendo defendible.
CREATE POLICY payment_lookup ON pay_connections FOR SELECT
  USING (current_setting('app.payment_lookup', true) = 'on');

-- El token identifica la conexión globalmente: la unicidad no puede ser por
-- tenant, porque el tenant es justamente lo que se está resolviendo.
CREATE UNIQUE INDEX idx_pay_connections_token ON pay_connections (webhook_token);
-- Una conexión activa por (tenant, proveedor, marca). El índice usa COALESCE
-- porque en SQL dos NULL no colisionan, y sin esto un tenant podría acabar con
-- dos conexiones «para todas las marcas» y cobrar por la que tocara.
CREATE UNIQUE INDEX idx_pay_connections_activa
  ON pay_connections (tenant_id, provider, COALESCE(brand_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status <> 'disabled';

-- ---------------------------------------------------------------------------
-- INTENCIONES DE PAGO. El importe que se espera cobrar, y en qué va.
-- ---------------------------------------------------------------------------
CREATE TABLE pay_intents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL,
  order_id       uuid NOT NULL,

  -- Referencia opaca que viaja a la pasarela y vuelve en el webhook. NO es el
  -- id interno: un identificador que se publica acaba en logs de terceros, en
  -- la barra del navegador y en capturas de pantalla.
  reference      text NOT NULL,
  -- Identificador del cargo EN la pasarela, cuando lo asigna.
  provider_ref   text,

  status         text NOT NULL DEFAULT 'pending',
  CONSTRAINT estado_pago_valido
    CHECK (status IN ('pending','authorized','captured','failed','expired','refunded')),

  -- Dinero: NUMERIC(14,4), nunca float (ADR-0013).
  amount         numeric(14,4) NOT NULL CHECK (amount > 0),
  currency       text NOT NULL DEFAULT 'PEN',
  -- Lo que la pasarela dijo haber cobrado. Se guarda aunque NO cuadre: es la
  -- prueba de la discrepancia, y sin ella la conciliación es una discusión.
  paid_amount    numeric(14,4),

  -- Motivo por el que un pago no se confirmó pese a llegar su aviso: importe
  -- distinto, moneda distinta, transición imposible.
  mismatch_reason text,

  expires_at     timestamptz NOT NULL,
  captured_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES pay_connections (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE CASCADE,

  -- Un pago capturado tiene que decir cuándo. Sin esto, «cobrado» sin fecha
  -- pasa la conciliación y falla la contabilidad.
  CONSTRAINT capturado_tiene_fecha
    CHECK (status <> 'captured' OR captured_at IS NOT NULL)
);

ALTER TABLE pay_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_intents FORCE ROW LEVEL SECURITY;
-- SIN escape de ningún tipo. Es una tabla con importes (ADR-0016 §1).
CREATE POLICY tenant_isolation ON pay_intents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- La referencia es la clave con la que vuelve el webhook: global y única.
CREATE UNIQUE INDEX idx_pay_intents_reference ON pay_intents (reference);
CREATE INDEX idx_pay_intents_order ON pay_intents (tenant_id, order_id);
-- El barrido de expiración busca lo abierto y vencido, cross-tenant.
CREATE INDEX idx_pay_intents_por_vencer ON pay_intents (expires_at)
  WHERE status IN ('pending','authorized');

-- ---------------------------------------------------------------------------
-- EVENTOS RECIBIDOS DE LA PASARELA.
--
-- Es la deduplicación de RN-PAY-01 puesta donde no se puede olvidar: la clave
-- única. Las pasarelas reintentan —todas— y un webhook duplicado no puede
-- confirmar dos veces ni cobrar dos comisiones. La fila se escribe en la MISMA
-- transacción que el efecto sobre la intención (ADR-0010).
-- ---------------------------------------------------------------------------
CREATE TABLE pay_webhook_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL,
  provider       text NOT NULL,
  -- Identificador del evento en la pasarela. Si no manda uno propio, se deriva
  -- del contenido (`provider:reference:status`): lo que se quiere deduplicar es
  -- el mismo HECHO, no el mismo paquete.
  event_id       text NOT NULL,
  intent_id      uuid,

  payload        jsonb NOT NULL,
  -- Qué se hizo con él. `ignored` es un desenlace legítimo y frecuente: el
  -- aviso llegó tarde o repetido.
  outcome        text NOT NULL,
  CONSTRAINT desenlace_webhook_valido
    CHECK (outcome IN ('applied','ignored','rejected','mismatch')),
  detail         text,
  trace_id       text,
  received_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES pay_connections (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, intent_id)
    REFERENCES pay_intents (tenant_id, id) ON DELETE SET NULL
);

ALTER TABLE pay_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_system ON pay_webhook_events
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
  );

-- LA restricción que hace idempotente el webhook. No es un índice de consulta:
-- es la regla de negocio escrita donde no se puede saltar.
CREATE UNIQUE INDEX idx_pay_webhook_dedupe
  ON pay_webhook_events (tenant_id, provider, event_id);
CREATE INDEX idx_pay_webhook_intent ON pay_webhook_events (tenant_id, intent_id);

-- Registro de lo recibido: append-only, como la auditoría. Un aviso de pasarela
-- que se puede editar después deja de servir para resolver una disputa.
REVOKE UPDATE, DELETE ON pay_webhook_events FROM sahana_app;
