# Módulo: Catalog
> Fase: 4 · Depende de: Organization · ADRs: 0007

## Alcance
Categorías, productos, variantes, grupos de modificadores (min/max, obligatorios), combos, listas de precios por (marca, canal, local?), disponibilidad por horario, pausa de producto/canal, imágenes, alérgenos (v1). Publicación versionada del catálogo hacia canales.
## Reglas
RN-CAT-01 Precio resuelto por prioridad: (marca,canal,local) → (marca,canal) → base. Sin precio para el canal → producto invisible en ese canal. RN-CAT-02 Cambio de precio NO afecta pedidos confirmados (snapshot). RN-CAT-03 `is_paused` propagable a canales < 60 s (evento catalog.availability_changed). RN-CAT-04 Combo: precio propio + composición; el consumo de inventario es por componentes. RN-CAT-05 Modificadores con precio ± y reglas min/max validadas en @sahana/domain (mismo código en PWA).
## API
CRUD completo · POST /catalog/publish (versión inmutable para canales/PWA) · GET /catalog/resolved?brand&channel&location (lo que consume tienda/POS; cacheado 60 s) · POST /products/:id/pause {channels[], until?}.
## Pruebas
Resolución de precio en los 3 niveles · combo con modificadores · pausa propagada (medir <60 s con evento) · If-Match concurrente · aislamiento.
## Aceptación
La PWA opera con catálogo versionado offline; diff de versiones descargable; publicación no bloquea ventas en curso.
