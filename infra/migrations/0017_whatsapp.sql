-- 0017 — WhatsApp: contactos, consentimiento y mensajes (spec 12, T4.28).
--
-- REVISAR SIEMPRE ESTE DIFF: toca DATOS PERSONALES y CONSENTIMIENTO. La Ley
-- 29733 y la política de Meta no piden «un booleano de marketing»: piden poder
-- demostrar QUÉ aceptó esa persona, CUÁNDO y DÓNDE. Un `accepts_marketing`
-- suelto no lo demuestra.
--
-- Tres decisiones que definen la forma:
--
-- 1. **El opt-out es una COLUMNA DEL CONTACTO, no una fila de consentimiento**
--    (RN-WA-04). Darse de baja tiene que ser inmediato y persistente, y
--    comprobarlo no puede depender de interpretar un histórico: se mira un
--    campo y se acabó. El histórico queda al lado, para poder explicar.
--
-- 2. **El consentimiento es APPEND-ONLY y guarda el texto exacto.** Si mañana
--    cambia la política y alguien pregunta qué aceptó un cliente en 2026, la
--    respuesta tiene que ser el texto de 2026, no el de hoy.
--
-- 3. **Los mensajes se deduplican por `provider_message_id`** (RN-WA-05). El
--    webhook de Meta entrega at-least-once: sin la clave única, un reintento
--    de su lado cuenta como un mensaje más en el KPI de costo y puede
--    reabrir la ventana de 24 h que ya se había cerrado.

-- ---------------------------------------------------------------------------
-- Contactos.
-- ---------------------------------------------------------------------------
CREATE TABLE wa_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,

  -- E.164 sin espacios ni guiones: +51987654321.
  phone       text NOT NULL,
  CONSTRAINT telefono_e164 CHECK (phone ~ '^\+[1-9]\d{7,14}$'),

  display_name text,

  -- Último mensaje ENTRANTE. Es lo que abre la ventana de servicio de 24 h.
  -- Guardar el saliente en su lugar la mantendría abierta para siempre:
  -- bastaría escribirle al cliente para poder volver a escribirle.
  last_inbound_at timestamptz,

  -- RN-WA-04: inmediato y persistente. Se mira un campo, no un histórico.
  opted_out    boolean NOT NULL DEFAULT false,
  opted_out_at timestamptz,
  CONSTRAINT baja_con_fecha CHECK (opted_out = false OR opted_out_at IS NOT NULL),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, phone)
);

ALTER TABLE wa_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wa_contacts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Consentimiento (RN-T10, Ley 29733). APPEND-ONLY.
-- ---------------------------------------------------------------------------
CREATE TABLE wa_consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL,

  action      text NOT NULL,
  CONSTRAINT accion_valida CHECK (action IN ('granted','revoked')),

  -- Dónde lo dio: checkout web, POS, respuesta por WhatsApp, importación.
  source      text NOT NULL,
  -- EL TEXTO EXACTO que aceptó. Es el requisito que no se puede reconstruir
  -- después: si mañana cambia la política, la respuesta a «¿qué aceptó este
  -- cliente?» tiene que ser el texto de entonces.
  consent_text text NOT NULL,
  actor_id    uuid,
  ip_address  inet,
  occurred_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)
    REFERENCES wa_contacts (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE wa_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wa_consents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_wa_consents_contacto
  ON wa_consents (tenant_id, contact_id, occurred_at DESC);

-- Un registro de consentimiento que se puede editar no demuestra nada.
REVOKE UPDATE, DELETE ON wa_consents FROM sahana_app;

-- ---------------------------------------------------------------------------
-- Mensajes. Es también el registro de COSTO (RN-WA-01).
-- ---------------------------------------------------------------------------
CREATE TABLE wa_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL,
  order_id    uuid,

  direction   text NOT NULL,
  CONSTRAINT direccion_valida CHECK (direction IN ('inbound','outbound')),

  -- `freeform` dentro de la ventana de 24 h (gratis); `template` fuera (se
  -- cobra). Guardarlo permite explicar la factura de Meta línea a línea.
  kind        text,
  CONSTRAINT tipo_valido CHECK (kind IS NULL OR kind IN ('freeform','template')),
  template_name text,
  -- Fuera de ventana SOLO caben plantillas aprobadas (RN-WA-02). Sin esto
  -- cabría un `template` sin nombre, que Meta descarta en silencio.
  CONSTRAINT plantilla_con_nombre CHECK (
    kind <> 'template' OR template_name IS NOT NULL
  ),

  body        text,

  status      text NOT NULL DEFAULT 'queued',
  CONSTRAINT estado_valido CHECK (status IN (
    'queued','sent','delivered','read','failed','received'
  )),

  -- Id del proveedor. Es la clave de dedupe del webhook (RN-WA-05).
  provider_message_id text,
  provider    text,
  error_code  text,
  error_message text,

  attempts    integer NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)
    REFERENCES wa_contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE SET NULL
);

ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wa_messages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Dedupe del webhook (RN-WA-05). El webhook de Meta entrega at-least-once: sin
-- esto, un reintento de su lado cuenta como un mensaje más en el KPI de costo
-- y puede reabrir una ventana de 24 h que ya se había cerrado.
CREATE UNIQUE INDEX idx_wa_messages_proveedor
  ON wa_messages (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- UN aviso por pedido y estado. Es la garantía de la BASE de que un evento
-- entregado dos veces no le manda al cliente dos veces «tu pedido está en
-- camino» — y no le cobra dos veces al tenant.
CREATE UNIQUE INDEX idx_wa_messages_aviso_unico
  ON wa_messages (tenant_id, order_id, template_name)
  WHERE order_id IS NOT NULL AND direction = 'outbound'
        AND template_name IS NOT NULL;

CREATE INDEX idx_wa_messages_contacto
  ON wa_messages (tenant_id, contact_id, occurred_at DESC);
-- Para el KPI de mensajes por pedido del panel de costos.
CREATE INDEX idx_wa_messages_pedido
  ON wa_messages (tenant_id, order_id) WHERE order_id IS NOT NULL;
