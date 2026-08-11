-- 0035 — Qué medios de pago acepta cada negocio en su tienda.
--
-- Hasta ahora el checkout solo distinguía «en línea» o «contra entrega», y la
-- tienda no tenía forma de saber qué acepta el negocio: enseñaba lo mismo a
-- todos. Eso se rompe en cuanto un cliente cobra solo en efectivo y otro acepta
-- Yape y tarjeta.
--
-- Y es lo que hace falta para las CARTERAS (Apple Pay, Google Pay). Una cartera
-- no es una pasarela: es un token de red que la pasarela desencripta. No se
-- «activa» en nuestro código — se activa cuando el negocio tiene la cuenta y la
-- pasarela lo soporta. Guardarlo aquí convierte eso en configuración en vez de
-- en un despliegue.
ALTER TABLE pay_connections
  ADD COLUMN methods text[] NOT NULL DEFAULT ARRAY['card']::text[];

COMMENT ON COLUMN pay_connections.methods IS
  'Medios habilitados en esta conexión: card | yape | plin | apple_pay | google_pay. Las carteras solo funcionan si la pasarela y las cuentas del negocio las soportan.';

-- Un medio que no reconocemos no se enseña, pero tampoco puede entrar: la
-- tienda lo pintaría como un botón que no cobra.
ALTER TABLE pay_connections
  ADD CONSTRAINT medios_de_pago_conocidos CHECK (
    methods <@ ARRAY['card','yape','plin','apple_pay','google_pay']::text[]
  );

-- ---------------------------------------------------------------------------
-- Verificación de dominio de Apple Pay.
--
-- Apple exige un archivo suyo servido en `/.well-known/` de **cada dominio**
-- que vaya a enseñar el botón. En un SaaS multimarca eso no es un archivo: es
-- uno por cliente, y los sirve el mismo servidor de tienda que resuelve por
-- host. Sin esto, el botón de Apple Pay no aparece y no hay ningún error que lo
-- explique.
--
-- Se guarda el contenido, no una ruta: el archivo lo emite Apple para ese
-- dominio concreto y no es derivable de nada nuestro.
-- ---------------------------------------------------------------------------
ALTER TABLE sto_domains
  ADD COLUMN apple_pay_verification text;

COMMENT ON COLUMN sto_domains.apple_pay_verification IS
  'Contenido del archivo de verificación de Apple para este dominio. Se sirve en /.well-known/apple-developer-merchantid-domain-association.';
