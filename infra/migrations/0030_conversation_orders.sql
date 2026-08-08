-- 0030 — De qué conversación salió cada pedido (spec 19 §6, T5.32).
--
-- El vínculo YA existía, pero solo como texto: `createOrderFromInbox` escribía
-- el id del pedido dentro del `payload` JSON de un mensaje de sistema y en la
-- fila de auditoría. Sirve para que un agente lo LEA en el hilo; no sirve para
-- contar. «¿Cuántas conversaciones que atendió la IA acabaron en pedido?» —la
-- métrica que decide si el agente se queda o se apaga— salía de rebuscar
-- dentro de un JSON de mensajes, y una métrica así no se calcula: se estima.
--
-- Es la misma forma del fallo de T5.07 (`commission_estimated` con nadie que la
-- escribiera) y de T4.30 (`processPending` sin llamar): el dato está, pero no
-- donde se pueda usar.
--
-- Va en el lado de Conversaciones y no como columna de `ord_orders` a
-- propósito. Ordering NO puede depender de Conversations —Conversations ya
-- depende de Ordering— y una clave foránea de `ord_orders` hacia
-- `cnv_conversations` invertiría esa flecha en el esquema aunque el código
-- siguiera limpio.
CREATE TABLE cnv_conversation_orders (
  tenant_id       uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  order_id        uuid NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, conversation_id, order_id),

  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES cnv_conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES ord_orders (tenant_id, id) ON DELETE CASCADE,

  -- Un pedido sale de UNA conversación. Sin esta restricción, un reintento del
  -- endpoint contaría el mismo pedido dos veces y la tasa de conversión
  -- superaría el 100 % sin que nada fallara.
  UNIQUE (tenant_id, order_id)
);

ALTER TABLE cnv_conversation_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE cnv_conversation_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cnv_conversation_orders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX idx_cnv_orders_conversacion
  ON cnv_conversation_orders (tenant_id, conversation_id);
