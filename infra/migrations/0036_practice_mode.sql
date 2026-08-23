-- Modo práctica (docs/26 §4).
--
-- «Datos demo descartables con un botón "borrar práctica y empezar en serio"
-- (borra ventas demo, conserva catálogo).»
--
-- Un dueño que acaba de dar de alta su negocio necesita equivocarse: cobrar mal,
-- anular, cerrar la caja con descuadre, mandar una comanda a la cocina que no
-- existe. Si esas pruebas se quedan mezcladas con las ventas de verdad, el
-- primer informe de rentabilidad miente y el primer cuadre con SUNAT no cuadra.
-- Y si por miedo a ensuciar NO prueba, se estrena el sábado a las ocho.
--
-- ## Por qué una MARCA DE TIEMPO y no un booleano por fila
--
-- La alternativa era `es_practica boolean` en cada pedido, cada comprobante,
-- cada sesión de caja. Serían quince columnas nuevas que hay que acordarse de
-- rellenar en quince sitios, y la que se olvide deja una venta de práctica
-- contada como real para siempre.
--
-- Con una sola marca en el tenant la regla es una y no se puede olvidar: **todo
-- lo operativo anterior a `went_live_at` es práctica**. Mientras esté en NULL el
-- negocio está practicando; al pulsar el botón se borra lo operativo y se
-- estampa la fecha. Y desde ese momento el botón ya no existe: no hay forma de
-- vaciar las ventas de un negocio que ya opera de verdad, ni por error ni a
-- propósito.
ALTER TABLE ten_tenants
  ADD COLUMN went_live_at timestamptz;

COMMENT ON COLUMN ten_tenants.went_live_at IS
  'Cuándo dejó de practicar. NULL = sigue en modo práctica y puede vaciar sus '
  'ventas de prueba. Con fecha, ese botón desaparece para siempre (docs/26 §4).';
