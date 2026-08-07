# Módulo: Organization
> Fase: 3 · Depende de: Tenancy, Identity

## Alcance
Empresas (RUC, series de comprobante), marcas (branding, slug, dominio), locales (dirección, geo, tz), cocinas, estaciones, almacenes, zonas de cobertura (polígonos), horarios. Relación brand↔kitchen M:N.
## Reglas
RN-ORG-01 brand_kitchen M:N; una marca sin cocina asignada no puede recibir pedidos (validación en Ordering). RN-ORG-02 Zona = polígono + tarifa + pedido mínimo + tiempo base; solapamiento permitido, gana la de menor tarifa (configurable). **Implementación: ver ADR-0015** — el polígono se guarda como GeoJSON en jsonb y la evaluación vive en `@sahana/domain` (compartida con tienda, agente IA y POS offline), no en PostGIS. La frontera cuenta como DENTRO. RN-ORG-03 Horarios por (marca, local, canal) con excepciones por fecha (feriados). RN-ORG-04 Desactivar local/cocina exige que no tenga pedidos activos (409 con lista).
## API
CRUD empresas/marcas/locales/cocinas/estaciones/almacenes/zonas/horarios · GET /coverage?lat&lng&brand → zona aplicable o 404.
## Pruebas
Punto en frontera de polígono · horario cruzando medianoche · M:N con 2 marcas 1 cocina y viceversa · aislamiento.
## Aceptación
Semilla demo: 1 tenant, 1 empresa, 2 marcas, 1 local, 1 cocina compartida, 3 estaciones, 2 zonas — usada por todos los E2E.

## Nota de implementación (T3.12)
Divergencia registrada respecto de «polígono geography»: ver **ADR-0015**. Se cumple el propósito de la regla con el cálculo en el dominio compartido, lo que garantiza que tienda, agente de IA, POS offline y servidor den la misma respuesta de cobertura. La jerarquía usa **FKs compuestas con `tenant_id`** (docs/09 §4), de modo que la base de datos impide relacionar entidades de tenants distintos. Los horarios (incluido el turno que cruza medianoche) también se evalúan en el dominio.
