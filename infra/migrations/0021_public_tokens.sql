-- 0021 — Tokens públicos de acceso acotado (ADR-0017) y reembolsos aprobados.
--
-- ADR-0016 cerró avisando: «si apareciera un quinto escape, la conversación ya
-- no es añadimos otro sino hace falta un mecanismo de primera clase». Aparecieron
-- dos a la vez —links de pago (T5.05) y tracking público (T5.16)— y se ven venir
-- más: recuperación de carrito, encuestas, confirmación de correo.
--
-- Todos tienen la misma forma: una URL que llega a alguien SIN cuenta y que
-- tiene que resolver un tenant. La salida fácil —una columna `algo_token` en la
-- tabla del recurso y otra política de escape— termina mal de forma concreta:
-- cada escape nuevo es una tabla de negocio más legible sin contexto de tenant,
-- y la frase que sostiene ADR-0014 se vuelve falsa por acumulación sin que
-- ninguna decisión individual parezca mala.

-- ---------------------------------------------------------------------------
-- TOKENS PÚBLICOS. Una tabla, un escape, todos los casos.
-- ---------------------------------------------------------------------------
CREATE TABLE pub_tokens (
  token         text PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,

  -- Para QUÉ sirve. Enum cerrado: un token de tracking presentado en la ruta de
  -- pago NO resuelve, porque el llamador declara qué propósito espera y el
  -- resolutor lo comprueba. Sin esto, un token filtrado en un sitio abriría
  -- todos los demás.
  purpose       text NOT NULL,
  CONSTRAINT proposito_valido
    CHECK (purpose IN ('payment_link','order_tracking')),

  -- El token NO lleva datos: lleva una referencia. Resolverlo dice de quién es
  -- y sobre qué; el contenido lo lee después el módulo dueño con withTenant.
  resource_type text NOT NULL,
  resource_id   uuid NOT NULL,

  -- NOT NULL a propósito: no hay tokens públicos eternos. Un enlace que circula
  -- por WhatsApp durante meses acaba en un grupo que no es el que era.
  expires_at    timestamptz NOT NULL,
  -- Primera apertura. Se registra para medir y para poder revocar; NO bloquea
  -- la segunda (ADR-0017): un link de pago que muere al abrirse pierde la venta
  -- del cliente al que le sonó el teléfono.
  used_at       timestamptz,
  -- Cortar hoy un enlace que se mandó al cliente equivocado, sin esperar a que
  -- caduque. Es la razón por la que esto es una tabla y no un JWT firmado.
  revoked_at    timestamptz,

  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, token)
);

ALTER TABLE pub_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE pub_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pub_tokens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- EL escape, quinto y último de su especie (ADR-0017). Solo SELECT, solo esta
-- tabla, y esta tabla no contiene datos de negocio: contiene referencias.
CREATE POLICY public_token_lookup ON pub_tokens FOR SELECT
  USING (current_setting('app.public_token', true) = 'on');

-- El barrido de limpieza busca lo caducado, cross-tenant.
CREATE INDEX idx_pub_tokens_caducados ON pub_tokens (expires_at);
CREATE INDEX idx_pub_tokens_recurso
  ON pub_tokens (tenant_id, resource_type, resource_id);

-- ---------------------------------------------------------------------------
-- REEMBOLSOS CON APROBACIÓN (RN-PAY-03).
--
-- Un reembolso sobre el umbral necesita DOS personas: quien lo pide y quien lo
-- aprueba. No es burocracia — es el control que impide que una sola cuenta
-- comprometida vacíe la caja del tenant en devoluciones a cuentas ajenas.
-- ---------------------------------------------------------------------------
ALTER TABLE pay_intents
  -- Quién pidió la devolución manual y quién la aprobó. NULL en las
  -- automáticas (T5.04), que las pide el sistema.
  ADD COLUMN refund_requested_by uuid,
  ADD COLUMN refund_approved_by  uuid,
  -- El umbral es por tenant y se guarda en el plan/config; aquí queda el que
  -- estaba vigente cuando se aprobó, porque cambiarlo después no puede
  -- reescribir la historia de una aprobación.
  ADD COLUMN refund_threshold_applied numeric(14,4);
