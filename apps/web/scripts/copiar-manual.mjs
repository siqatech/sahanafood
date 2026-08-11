import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copia el manual de la API al `public/` de la web.
 *
 * Existe por un detalle del despliegue que no se ve mirando el código: la
 * imagen de producción se construye con `output: standalone`, y su etapa final
 * copia **solo** `.next/standalone`, `.next/static` y `public/`. `docs/` no
 * llega al contenedor. Un manejador de ruta que leyera `docs/38-…` funcionaría
 * en desarrollo y devolvería 500 en producción — el peor reparto posible.
 *
 * Se copia en vez de duplicar el texto para que haya UNA sola fuente. El
 * manual es un documento del repositorio y sigue siéndolo; esto solo lo pone
 * donde el desarrollador del cliente puede leerlo, que es el sitio del que
 * hasta ahora el panel le daba la ruta sin poder abrirla.
 */

const aqui = dirname(fileURLToPath(import.meta.url));
const origen = join(aqui, '..', '..', '..', 'docs', '38-api-de-pedidos.md');
const destino = join(aqui, '..', 'public', 'manual-api.md');

const contenido = readFileSync(origen, 'utf8');
mkdirSync(dirname(destino), { recursive: true });
writeFileSync(destino, contenido, 'utf8');

console.log(
  `manual-api.md ← docs/38-api-de-pedidos.md (${contenido.length} B)`,
);
