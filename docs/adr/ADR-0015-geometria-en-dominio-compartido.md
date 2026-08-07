# ADR-0015 — Geometría de cobertura en el dominio compartido, no en PostGIS

| Campo | Valor |
|---|---|
| Estado | **Aceptado** (implementado en T3.12) |
| Fecha | 7 de agosto de 2026 |
| Depende de | ADR-0006 (dominio compartido servidor/cliente), spec 03 (Organization) |
| Revisar si | Se cumple alguno de los disparadores medidos de §5 |

## 1. Contexto

La spec del módulo Organization describe las zonas de cobertura como «polígono
`geography`», que en PostgreSQL significa **PostGIS**. Al implementarlo aparecen
tres hechos que la spec no consideró:

1. **La cobertura no se evalúa solo en el servidor.** La tienda web la consulta
   al pedir la dirección (que es la *primera* pantalla del checkout, docs/25),
   el agente de IA la necesita para responder «¿llegan a mi casa?», y el POS
   puede necesitarla sin internet. Si el cálculo vive únicamente en la base de
   datos, cada cliente necesita un viaje de red y, offline, no hay respuesta.

2. **La divergencia entre cliente y servidor es el riesgo caro.** Es el mismo
   argumento que decidió el ADR-0006 para el dinero: si la tienda le dice al
   cliente que hay cobertura y el servidor luego lo rechaza, el pedido se
   pierde y la confianza también. Un único algoritmo compartido lo hace
   imposible por construcción.

3. **El volumen es pequeño.** Un tenant tiene del orden de decenas de zonas, no
   millones. Un `point-in-polygon` sobre decenas de polígonos en TypeScript son
   microsegundos; el índice espacial de PostGIS resuelve un problema de escala
   que este producto no tiene todavía.

A eso se suma un detalle operativo: `CREATE EXTENSION postgis` requiere
superusuario, y nuestro rol migrador **no lo es** por diseño (docs/09 §3, ya
obligó a evitar `pgcrypto` en la migración 0001).

## 2. Decisión

**El cálculo de cobertura vive en `@sahana/domain`.** Los polígonos se almacenan
como anillos GeoJSON en `jsonb`, con el **bounding box precalculado e indexado**
en columnas propias.

- `isPointInPolygon` — cruce de rayos, con la **frontera contando como dentro**.
  Esto es una regla de negocio explícita, no un detalle numérico: al cliente
  cuya dirección cae justo en el límite se le da servicio, siempre, y no según
  el error de redondeo del día.
- `selectCoverageZone` — ante solapamiento gana la **menor tarifa** (RN-ORG-02),
  con desempates deterministas (mínimo, tiempo base, id) para que dos consultas
  idénticas jamás devuelvan zonas distintas.
- El bounding box permite descartar zonas en SQL antes de evaluar el polígono,
  cuando el volumen lo justifique.

Lo mismo aplica a los horarios (`isOpenAt`), incluido el turno que cruza
medianoche: la tienda, el POS y el servidor deben coincidir en si el local está
abierto.

## 3. Divergencia respecto de la spec

Esta decisión **se aparta de la letra de la spec 03** («polígono geography») y
se registra aquí conforme a la regla 4 de CLAUDE.md. Se cumple el *propósito*
—resolver cobertura por polígonos con tarifa, mínimo y tiempo base— con una
implementación distinta. La spec debería actualizarse para referenciar este ADR.

## 4. Consecuencias

- **+** Una sola definición de «tener cobertura», ejecutada idéntica en tienda,
  agente, POS y servidor. Verificable con pruebas de propiedad.
- **+** Sin dependencia de extensión ni de superusuario; el entorno local y CI
  siguen usando `postgres:16-alpine` sin cambios.
- **+** El cliente offline puede validar cobertura sin red.
- **−** Sin índice espacial: la consulta trae las zonas activas del tenant (con
  pre-filtro por bounding box) y decide en memoria. Aceptable en decenas de
  zonas, no en miles.
- **−** Cálculo planar sobre grados. A escala de ciudad el error queda muy por
  debajo de la precisión de un GPS de teléfono; no sirve para distancias largas
  ni para áreas, que hoy no se necesitan.
- **−** Sin operaciones geoespaciales avanzadas (intersecciones, buffers,
  distancias geodésicas). Si el producto las pide, PostGIS vuelve a la mesa.

## 5. Disparadores de revisión

Se reabre esta decisión ante cualquiera de estos hechos **medidos**:

1. Un tenant supera ~500 zonas activas, o el p95 de `GET /coverage` supera
   50 ms por el coste del cálculo en memoria.
2. Se requiere ruteo, distancia real de reparto o áreas (probable en F5–F6 con
   Delivery: asignación por cercanía).
3. Se necesitan consultas espaciales cruzadas (p. ej. «qué zonas se solapan»)
   como funcionalidad de producto, no como diagnóstico puntual.

En ese caso la migración es aditiva y sin reescritura: se añade una columna
`geography` poblada desde el mismo GeoJSON y PostGIS pasa a ser el pre-filtro,
manteniendo el dominio como la autoridad para el cliente offline.
