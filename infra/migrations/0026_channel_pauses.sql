-- 0026 — Canales pausados (RN-KIT-04, T5.18).
--
-- Va aparte de `0025` porque aquella ya estaba aplicada cuando se vio que
-- hacía falta esta tabla. Editar una migración ya corrida deja los entornos
-- divergentes en silencio: el que ya la aplicó no vuelve a ejecutarla y se
-- queda sin la tabla, mientras el siguiente entorno la crea. Una migración
-- aplicada es historia, no un borrador.

-- ---------------------------------------------------------------------------
-- CANALES PAUSADOS.
--
-- Vive en `ord_*` y no en `kit_*` a propósito. Quien tiene que consultarla es
-- ORDERING, al aceptar un pedido, y Ordering no puede depender de Kitchen:
-- Kitchen ya depende de Ordering (consume `order.accepted`) y la flecha
-- inversa cerraría el ciclo. Con la tabla aquí, Kitchen —que sí puede importar
-- Ordering— llama a su API pública para pausar, y Ordering solo consulta lo
-- suyo.
--
-- La alternativa era pausar producto a producto en `cat_product_pauses`: miles
-- de filas por cada pico, y un despausado que hay que acertar entero. Pausar
-- el CANAL es una fila.
-- ---------------------------------------------------------------------------
CREATE TABLE ord_channel_pauses (
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  location_id   uuid NOT NULL,
  channel       text NOT NULL,

  -- Quién lo pausó: `kitchen` (saturación automática) o `manual`. Importa
  -- porque el despausado automático NO debe levantar una pausa que puso una
  -- persona: si el encargado cerró Rappi porque se quedó sin pollo, que la
  -- cocina se descongestione no significa que ya haya pollo.
  paused_by     text NOT NULL DEFAULT 'kitchen',
  CONSTRAINT origen_pausa_valido CHECK (paused_by IN ('kitchen','manual')),

  reason        text,
  paused_at     timestamptz NOT NULL DEFAULT now(),
  -- Reapertura programada. NULL = hasta que alguien o algo la levante.
  until         timestamptz,

  PRIMARY KEY (tenant_id, location_id, channel),
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES org_locations (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE ord_channel_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ord_channel_pauses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ord_channel_pauses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
