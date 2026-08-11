-- 0032 — La oferta de bienvenida (spec 11).
--
-- Los cupones existían desde 0023 y no había forma de decir CUÁL es el que se
-- le enseña a quien entra por primera vez. Sin eso, un descuento de primera
-- compra solo funciona si el cliente ya conoce el código, que es justo al revés
-- de para lo que sirve: se usa para captar a quien no te conoce.
--
-- Es una marca sobre el cupón y no una tabla aparte a propósito. La oferta de
-- bienvenida no es una entidad distinta —tiene el mismo descuento, el mismo
-- mínimo, la misma caducidad y el mismo contador de usos que cualquier otra—;
-- lo único que cambia es que se anuncia sola.
ALTER TABLE sto_coupons
  ADD COLUMN is_welcome boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN sto_coupons.is_welcome IS
  'Se anuncia solo a quien entra por primera vez en la tienda de esta marca.';

-- Como mucho UNA por marca, y solo entre las activas.
--
-- Sin esta restricción, dos cupones marcados a la vez dejan la pregunta «¿cuál
-- se enseña?» resuelta por el orden que devuelva la base, que cambia sin avisar.
-- El día que el dueño crea la promoción de fiestas patrias sin acordarse de
-- apagar la anterior, la tienda anunciaría una y el cliente encontraría otra.
--
-- Va sobre `active` además de sobre la marca para que archivar la promoción
-- vieja —en vez de borrarla, que es lo que hay que hacer con algo que ya se
-- usó— libere el sitio para la nueva.
CREATE UNIQUE INDEX idx_cupon_bienvenida_unico
  ON sto_coupons (tenant_id, brand_id)
  WHERE is_welcome AND active;
