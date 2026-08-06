# Módulo: Organization
> Fase: 3 · Depende de: Tenancy, Identity

## Alcance
Empresas (RUC, series de comprobante), marcas (branding, slug, dominio), locales (dirección, geo, tz), cocinas, estaciones, almacenes, zonas de cobertura (polígonos), horarios. Relación brand↔kitchen M:N.
## Reglas
RN-ORG-01 brand_kitchen M:N; una marca sin cocina asignada no puede recibir pedidos (validación en Ordering). RN-ORG-02 Zona = polígono geography + tarifa + pedido mínimo + tiempo base; solapamiento permitido, gana la de menor tarifa (configurable). RN-ORG-03 Horarios por (marca, local, canal) con excepciones por fecha (feriados). RN-ORG-04 Desactivar local/cocina exige que no tenga pedidos activos (409 con lista).
## API
CRUD empresas/marcas/locales/cocinas/estaciones/almacenes/zonas/horarios · GET /coverage?lat&lng&brand → zona aplicable o 404.
## Pruebas
Punto en frontera de polígono · horario cruzando medianoche · M:N con 2 marcas 1 cocina y viceversa · aislamiento.
## Aceptación
Semilla demo: 1 tenant, 1 empresa, 2 marcas, 1 local, 1 cocina compartida, 3 estaciones, 2 zonas — usada por todos los E2E.
