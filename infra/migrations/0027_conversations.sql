-- 0027 — Bandeja omnicanal (spec 18, T5.19–T5.21).
--
-- El módulo que el agente de IA necesita EXISTIENDO ANTES que él: el agente
-- escribe EN una conversación. Construirlo al revés obligaría al agente a tener
-- su propio almacén de mensajes y luego a fusionarlo con el histórico ya
-- escrito, que es una migración de datos con conversaciones de clientes reales
-- dentro.

-- ---------------------------------------------------------------------------
-- CONVERSACIONES.
--
-- La clave del módulo es RN-CNV-01: una conversación pertenece a
-- **(tenant, marca, canal, contacto)**. El mismo teléfono escribiendo a dos
-- marcas del mismo tenant son DOS conversaciones.
--
-- Es lo contrario de lo que haría un help desk normal —una conversación por
-- persona— y tiene dos motivos que no son teóricos: el branding de la
-- respuesta (quien escribe a la pollería no debe recibir el saludo del wok) y
-- la trazabilidad (el pedido, el agente y el coste del mensaje son de una marca
-- concreta, y mezclarlos hace imposible saber qué marca gasta en atención).
-- ---------------------------------------------------------------------------
CREATE TABLE cnv_conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid NOT NULL,
  channel       text NOT NULL,
  CONSTRAINT canal_valido CHECK (channel IN ('whatsapp','web','email')),
  contact_id    uuid NOT NULL,

  -- bot → waiting_human → assigned → resolved → (reabre con nuevo mensaje).
  status        text NOT NULL DEFAULT 'bot',
  CONSTRAINT estado_conversacion_valido
    CHECK (status IN ('bot','waiting_human','assigned','resolved')),

  assignee_id   uuid,
  queue         text NOT NULL DEFAULT 'general',

  -- IA activada en ESTA conversación. Que sea por conversación y no solo
  -- global es lo que permite al agente humano decir «de aquí me encargo yo»
  -- sin apagar el bot para todo el mundo.
  ai_enabled    boolean NOT NULL DEFAULT true,

  last_msg_at   timestamptz,
  last_inbound_at timestamptz,
  -- Se recalcula al recibir: es lo que alimenta la cuenta regresiva de
  -- RN-CNV-03. Se guarda además de derivarse para poder indexar «conversaciones
  -- cuya ventana se cierra en menos de una hora», que es la vista que un
  -- encargado mira de verdad en hora punta.
  window_expires_at timestamptz,

  /**
   * Resumen de contexto del traspaso bot → humano (RN-CNV-02).
   *
   * Obligatorio al pasar a `waiting_human` y por eso hay restricción abajo. La
   * regla existe porque la alternativa es lo que hace todo el mundo: el bot
   * pasa la conversación y el humano abre con «hola, ¿en qué puedo ayudarte?»,
   * obligando al cliente a contarlo todo otra vez. Es el momento exacto en el
   * que la gente abandona.
   */
  handoff_summary jsonb,
  handoff_at    timestamptz,

  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id)
    REFERENCES wa_contacts (tenant_id, id) ON DELETE CASCADE,

  CONSTRAINT asignada_tiene_agente
    CHECK (status <> 'assigned' OR assignee_id IS NOT NULL),
  -- El traspaso SIN resumen no es un traspaso: es empezar de cero.
  CONSTRAINT traspaso_lleva_resumen
    CHECK (status <> 'waiting_human' OR handoff_summary IS NOT NULL)
);

ALTER TABLE cnv_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cnv_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cnv_conversations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- UNA conversación abierta por (marca, canal, contacto). Dos abiertas del mismo
-- contacto en la misma marca es el mismo cliente en dos pantallas, y dos
-- agentes contestándole a la vez.
CREATE UNIQUE INDEX idx_cnv_abierta
  ON cnv_conversations (tenant_id, brand_id, channel, contact_id)
  WHERE status <> 'resolved';

-- La bandeja: por cola y estado, lo más antiguo primero.
CREATE INDEX idx_cnv_bandeja
  ON cnv_conversations (tenant_id, queue, status, last_msg_at);

-- Ventanas a punto de cerrarse: la vista que se mira en hora punta.
CREATE INDEX idx_cnv_ventana ON cnv_conversations (tenant_id, window_expires_at)
  WHERE status <> 'resolved';

-- ---------------------------------------------------------------------------
-- MENSAJES.
-- ---------------------------------------------------------------------------
CREATE TABLE cnv_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,

  direction     text NOT NULL,
  CONSTRAINT direccion_valida CHECK (direction IN ('inbound','outbound')),

  -- Quién lo escribió (RN-CNV-04). NO es un booleano «lo mandó el bot»: hace
  -- falta distinguir bot, agente concreto y sistema para poder responder «¿esto
  -- lo dijo la IA o una persona?» cuando un cliente reclame por algo que se le
  -- prometió. Con un booleano esa pregunta no tiene respuesta.
  author_type   text NOT NULL,
  CONSTRAINT autor_valido CHECK (author_type IN ('customer','bot','agent','system')),
  author_id     uuid,

  kind          text NOT NULL,
  CONSTRAINT tipo_mensaje_valido
    CHECK (kind IN ('text','interactive','template','media','note','system')),

  payload       jsonb NOT NULL,
  template_name text,
  wa_message_id text,

  status        text NOT NULL DEFAULT 'sent',
  CONSTRAINT estado_mensaje_valido
    CHECK (status IN ('queued','sent','delivered','read','failed')),
  error_reason  text,

  -- Coste estimado del mensaje, si es de pago. NUMERIC como todo el dinero.
  -- A partir del cambio de precios de Meta, un pedido de S/ 35 con doce avisos
  -- puede comerse su propio margen: sin esta columna eso no se ve hasta la
  -- factura.
  cost_estimate numeric(14,4),

  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES cnv_conversations (tenant_id, id) ON DELETE CASCADE,

  -- Un agente que escribe tiene que ser alguien. Sin esto, «lo dijo un agente»
  -- sin decir cuál no sirve para lo único que este campo existe.
  CONSTRAINT agente_identificado
    CHECK (author_type <> 'agent' OR author_id IS NOT NULL),
  -- Una NOTA INTERNA nunca sale (RN-CNV-07). La restricción en la base y no en
  -- el servicio: una nota que se envía al cliente por un fallo de código es
  -- exactamente el tipo de error que no se puede deshacer.
  CONSTRAINT nota_nunca_sale
    CHECK (kind <> 'note' OR direction = 'outbound'),
  CONSTRAINT plantilla_tiene_nombre
    CHECK (kind <> 'template' OR template_name IS NOT NULL)
);

ALTER TABLE cnv_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE cnv_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cnv_messages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_cnv_messages_hilo
  ON cnv_messages (tenant_id, conversation_id, created_at);

-- Idempotencia de entrada: el mismo mensaje de WhatsApp no entra dos veces.
-- Los webhooks de Meta reintentan, y sin esto el cliente vería su propia
-- pregunta duplicada en el hilo.
CREATE UNIQUE INDEX idx_cnv_messages_wa
  ON cnv_messages (tenant_id, wa_message_id)
  WHERE wa_message_id IS NOT NULL;

-- Búsqueda por texto (RN-CNV-08). Índice propio, sin motor dedicado: la spec
-- lo pide explícitamente hasta que haya una necesidad MEDIDA.
CREATE INDEX idx_cnv_messages_texto
  ON cnv_messages USING gin (to_tsvector('spanish', COALESCE(payload->>'text', '')));

-- ---------------------------------------------------------------------------
-- ETIQUETAS Y RESPUESTAS RÁPIDAS.
-- ---------------------------------------------------------------------------
CREATE TABLE cnv_tags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  name          text NOT NULL,
  color         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

ALTER TABLE cnv_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE cnv_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cnv_tags
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX idx_cnv_tags_nombre ON cnv_tags (tenant_id, lower(name));

CREATE TABLE cnv_conversation_tags (
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  tag_id        uuid NOT NULL,
  PRIMARY KEY (tenant_id, conversation_id, tag_id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES cnv_conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tag_id)
    REFERENCES cnv_tags (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE cnv_conversation_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE cnv_conversation_tags FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cnv_conversation_tags
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE cnv_quick_replies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  -- NULL = vale para todas las marcas del tenant.
  brand_id      uuid,
  shortcut      text NOT NULL,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE cnv_quick_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cnv_quick_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cnv_quick_replies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE UNIQUE INDEX idx_cnv_quick_atajo
  ON cnv_quick_replies (tenant_id, COALESCE(brand_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(shortcut));
