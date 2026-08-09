-- 0031 — Cómo se pagó un pedido del mostrador.
--
-- REVISAR SIEMPRE ESTE DIFF: toca DINERO.
--
-- Falta un dato que el POS ya conocía y el servidor tiraba a la basura. El
-- cajero elige «efectivo / tarjeta / yape» al cobrar, la PWA lo mandaba en el
-- lote de sincronización y `offlineOrderSchema` lo descartaba sin decir nada
-- (zod quita las claves que no declara).
--
-- La consecuencia no era cosmética: **ninguna venta del mostrador llegaba al
-- arqueo de caja**. `cash_movements` solo se escribía desde el endpoint manual
-- y desde el cobro contra entrega, así que un turno con S/ 2 000 en efectivo
-- cerraba con un «esperado» igual al fondo inicial y un sobrante del tamaño
-- exacto de lo vendido. Todos los días.
--
-- Con esto, el consumidor de caja puede saber si una venta movió la gaveta.
--
-- Compatible hacia atrás: columna nueva y anulable. La versión anterior de la
-- aplicación la ignora.

ALTER TABLE ord_orders ADD COLUMN payment_method text;

COMMENT ON COLUMN ord_orders.payment_method IS
  'Medio con el que se cobró en el mostrador: cash | card | wallet | transfer | other. NULL en canales donde el cobro lo lleva otro módulo (tienda web, marketplaces).';

-- El arqueo pregunta «qué ventas en efectivo hubo en este local hoy», y sin
-- índice eso es un recorrido de la tabla de pedidos en la hora de cierre, que
-- es justo cuando la caja está ocupada.
CREATE INDEX idx_orders_payment_method
  ON ord_orders (tenant_id, location_id, payment_method)
  WHERE payment_method IS NOT NULL;
