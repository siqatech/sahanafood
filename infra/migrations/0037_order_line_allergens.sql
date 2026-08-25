-- Alérgenos en el SNAPSHOT de la línea de pedido (docs/25, PA-16).
--
-- La comanda de cocina tiene que decir si el plato lleva mostaza, y hasta ahora
-- no tenía de dónde sacarlo: `ord_order_lines` copia nombre, cantidad y precio
-- (RN-ORD-02) y nada más. Leerlo del catálogo actual al pintar la comanda sería
-- más barato y estaría mal: si el dueño corrige la carta el martes, la comanda
-- del lunes empezaría a mentir sobre lo que se sirvió. El snapshot existe justo
-- para que el pasado no se pueda reescribir.
--
-- ## NULL y `[]` NO son lo mismo, y aquí la diferencia importa
--
--   ·  NULL  → «no se registró». Los pedidos anteriores a esta migración, y las
--              líneas que entran por caminos donde no hay catálogo que
--              consultar (una venta offline reconstruida, por ejemplo).
--   ·  '[]'  → «el restaurante no declaró ninguno».
--
-- Por eso la columna admite nulos y NO lleva `DEFAULT '[]'`: un valor por
-- defecto convertiría «no lo sé» en «no lleva nada», que es exactamente la
-- afirmación que nadie ha hecho. La pantalla dice una cosa u otra según el
-- caso; confundirlas es el error caro de una alergia.
ALTER TABLE ord_order_lines
  ADD COLUMN allergens jsonb;

COMMENT ON COLUMN ord_order_lines.allergens IS
  'Alérgenos declarados EN EL MOMENTO del pedido. NULL = no se registró; [] = el restaurante no declaró ninguno.';
