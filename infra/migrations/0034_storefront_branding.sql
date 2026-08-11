-- 0034 — La tienda con la marca del cliente, no con la nuestra.
--
-- Referencia explícita del propietario: la pantalla de *Branding* de Deliverect
-- —nombre, logo, imagen de portada y los colores— y su promesa de que la web de
-- pedidos «se vea tuya». Resuelve PA-12.
--
-- Va por MARCA y no por tenant porque un tenant multimarca es el caso normal de
-- este producto: la misma cocina sirve «El Buen Sabor» y «Sabor Wok», y cada una
-- tiene su dominio, su carta y su público. Con los colores en el tenant, las dos
-- tiendas se verían iguales, que es justo lo contrario de lo que se pide.
CREATE TABLE sto_branding (
  tenant_id     uuid NOT NULL REFERENCES ten_tenants (id) ON DELETE CASCADE,
  brand_id      uuid NOT NULL,

  -- Cómo se anuncia la marca en su tienda. Puede no ser el nombre interno:
  -- «Pollería El Buen Sabor S.A.C.» es la razón social, «El Buen Sabor» es lo
  -- que va en la cabecera.
  display_name  text,
  tagline       text,

  logo_url      text,
  cover_url     text,

  -- Colores en hexadecimal `#rrggbb`. Se validan al escribir (ver el servicio):
  -- un valor cualquiera aquí no da error, se cuela en el CSS y deja la tienda
  -- con el color por defecto del navegador sin que nadie entienda por qué.
  color_base    text,
  color_hover   text,
  color_texto   text,

  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, brand_id),
  FOREIGN KEY (tenant_id, brand_id)
    REFERENCES org_brands (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE sto_branding IS
  'Aspecto de la tienda de cada marca. Sin fila = colores por defecto de Sahana.';

ALTER TABLE sto_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE sto_branding FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_aislado ON sto_branding
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- La tienda pide su aspecto ANTES de saber de qué tenant es, igual que el
-- catálogo: se resuelve por host o por clave publicable. Solo lectura.
CREATE POLICY resolucion_publica ON sto_branding
  FOR SELECT
  USING (current_setting('app.public_token', true) = 'on');

GRANT SELECT, INSERT, UPDATE ON sto_branding TO sahana_app;
