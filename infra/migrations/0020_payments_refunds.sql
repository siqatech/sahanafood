-- 0020 — Devolución automática de cobros que no debieron confirmarse (T5.04).
--
-- El caso: la pasarela confirma un pago DESPUÉS de que el pedido venciera o se
-- rechazara. Pasa de verdad —el cliente paga en el último segundo, la pasarela
-- reintenta, la red tarda— y el resultado es dinero cobrado por comida que el
-- sistema ya decidió no hacer. Perder la venta es malo; cobrarla sin entregar
-- es peor, y además es el tipo de incidencia que llega por redes sociales.
--
-- Por qué una MARCA y no una devolución en el acto: la devolución es una
-- llamada de red a un tercero, y el proceso puede morirse entre capturar y
-- devolver. Si se hiciera en línea, ese hueco dejaría un cobro sin devolver y
-- sin nadie que lo supiera. La marca se escribe en la MISMA transacción que la
-- captura, así que o existen las dos cosas o no existe ninguna; un barrido la
-- recoge después. Es el patrón del outbox aplicado al dinero (ADR-0007).

ALTER TABLE pay_intents
  -- true = este cobro no debió confirmarse y hay que devolverlo.
  ADD COLUMN refund_required   boolean NOT NULL DEFAULT false,
  -- Por qué. Va al panel y a la auditoría: «se te devolvió» sin motivo es una
  -- llamada de soporte garantizada.
  ADD COLUMN refund_reason     text,
  ADD COLUMN refunded_at       timestamptz,
  ADD COLUMN refund_provider_ref text,
  -- Intentos de devolución. Una pasarela caída no puede dejar el dinero
  -- retenido para siempre en silencio: pasado el límite, esto es una alarma
  -- operativa que alguien tiene que atender a mano.
  ADD COLUMN refund_attempts   integer NOT NULL DEFAULT 0,
  ADD COLUMN refund_last_error text;

-- Un pago devuelto tiene que decir cuándo, igual que uno capturado.
ALTER TABLE pay_intents
  ADD CONSTRAINT devuelto_tiene_fecha
    CHECK (status <> 'refunded' OR refunded_at IS NOT NULL);

-- El barrido busca lo capturado que hay que devolver, cross-tenant y por
-- antigüedad: el dinero que lleva más tiempo retenido es el que más urge.
CREATE INDEX idx_pay_intents_por_devolver ON pay_intents (captured_at)
  WHERE refund_required AND status = 'captured';
