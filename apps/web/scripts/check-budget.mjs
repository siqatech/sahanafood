#!/usr/bin/env node
/**
 * Presupuesto de rendimiento móvil (T5.14).
 *
 * Criterio de la spec: **JS < 200 KB en el catálogo** y Lighthouse móvil ≥ 85
 * en catálogo y checkout.
 *
 * Este script comprueba la mitad que se puede comprobar en CI sin navegador ni
 * red: **el peso del JavaScript de la primera carga**. Se hace así, y no con
 * Lighthouse en el pipeline, por una razón práctica: la puntuación de
 * Lighthouse depende de la máquina que la mide, así que en CI o da falsos
 * rojos o hay que aflojar tanto el umbral que deja de significar nada. El peso
 * del bundle, en cambio, es el MISMO número en cualquier máquina, sale del
 * manifiesto de la propia compilación y es la causa principal de una mala
 * puntuación móvil. La medición de Lighthouse queda como entrega humana, con
 * dispositivo y red declarados (ver docs/32).
 *
 * Un presupuesto que solo se comprueba a mano se incumple el primer martes con
 * prisa. Este falla el build.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Presupuestos en BYTES COMPRIMIDOS, sobre el JS de primera carga, que es lo
 * que el navegador tiene que descargar y ejecutar antes de que la página sea
 * usable. Comprimido porque es lo que mide Lighthouse y lo que informa
 * `next build`: un presupuesto que da otro número que la herramienta a la vista
 * de todos acaba ignorado. Las cifras son las de la spec; bajarlas es
 * bienvenido, subirlas necesita justificarse en el PR.
 */
const PRESUPUESTOS = [
  { ruta: '/', nombre: 'catálogo', limite: 200 * 1024 },
  { ruta: '/producto/[id]', nombre: 'ficha', limite: 200 * 1024 },
  { ruta: '/carrito', nombre: 'carrito', limite: 200 * 1024 },
  { ruta: '/checkout', nombre: 'checkout', limite: 200 * 1024 },
];

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Quita los grupos de rutas —los segmentos entre paréntesis— de una clave del
 * manifiesto: `/(tienda)/carrito/page` → `/carrito/page`.
 *
 * Existe porque no hacerlo tuvo un coste real. La versión anterior buscaba la
 * clave `/carrito/page` tal cual, la tienda vive dentro del grupo `(tienda)`,
 * y por tanto NINGUNA búsqueda encontraba nada: las tres rutas daban el mismo
 * número, el de los trozos comunes, y el presupuesto pasaba en verde midiendo
 * cero de lo que decía medir. Un presupuesto roto es peor que ninguno, porque
 * el verde se lee como permiso.
 */
function sinGrupos(clave) {
  return clave.replace(/\/\([^/]+\)/g, '') || '/';
}

/**
 * Suma el JS de primera carga de una ruta a partir de los manifiestos de la
 * compilación: los trozos comunes a toda la app, los de la página, y los de
 * todos los layouts que la envuelven —sin el layout no se pinta nada, así que
 * no contarlo daría un número que ningún navegador llega a ver.
 */
function pesoDeRuta(ruta, manifiestoApp, manifiestoBuild, tamanos) {
  const archivos = new Set(manifiestoBuild.rootMainFiles ?? []);
  const paginas = manifiestoApp.pages ?? {};

  const claveDePagina = ruta === '/' ? '/page' : `${ruta}/page`;
  let encontrada = false;

  for (const [clave, trozos] of Object.entries(paginas)) {
    const normal = sinGrupos(clave);
    let aplica = false;

    if (normal === claveDePagina) {
      aplica = true;
      encontrada = true;
    } else if (normal.endsWith('/layout')) {
      // Un layout en `/x/layout` envuelve todo lo que cuelga de `/x`; el de la
      // raíz (`/layout`) envuelve la app entera.
      const dir = normal.slice(0, -'/layout'.length);
      aplica = dir === '' || ruta === dir || ruta.startsWith(`${dir}/`);
    }

    if (aplica) for (const archivo of trozos) archivos.add(archivo);
  }

  let total = 0;
  const desconocidos = [];
  for (const archivo of archivos) {
    if (!archivo.endsWith('.js')) continue;
    const tam = tamanos.get(archivo);
    if (tam === undefined) desconocidos.push(archivo);
    else total += tam;
  }
  return { total, archivos: archivos.size, desconocidos, encontrada };
}

async function main() {
  const dir = resolve(RAIZ, '.next');

  let manifiestoApp;
  let manifiestoBuild;
  try {
    manifiestoApp = JSON.parse(
      await readFile(resolve(dir, 'app-build-manifest.json'), 'utf8'),
    );
    manifiestoBuild = JSON.parse(
      await readFile(resolve(dir, 'build-manifest.json'), 'utf8'),
    );
  } catch {
    console.error(
      'No hay compilación que medir. Ejecuta antes: pnpm --filter @sahana/web build',
    );
    process.exit(1);
  }

  // Tamaño COMPRIMIDO (gzip) de cada trozo: es el que viaja por la red, el que
  // mide Lighthouse y el que informa el propio `next build`. Se midió primero
  // el tamaño en disco —el argumento era que analizar y ejecutar cuesta más que
  // descargar en un móvil de gama media— y resultó una mala idea por algo más
  // práctico: daba 353 KB donde Next dice 103 KB, así que el presupuesto se
  // ponía rojo en una página que la herramienta que todo el mundo mira declara
  // holgada. Un umbral que contradice al número visible no se respeta: se
  // ignora, o se sube hasta que calle.
  const { gzipSync } = await import('node:zlib');
  const tamanos = new Map();
  const vistos = new Set([
    ...(manifiestoBuild.rootMainFiles ?? []),
    ...Object.values(manifiestoApp.pages ?? {}).flat(),
  ]);
  for (const archivo of vistos) {
    if (!archivo.endsWith('.js')) continue;
    try {
      const contenido = await readFile(resolve(dir, archivo));
      tamanos.set(archivo, gzipSync(contenido, { level: 9 }).length);
    } catch {
      // Se reporta abajo como desconocido en vez de contarlo como cero: un
      // trozo que no se encuentra y se cuenta como cero es exactamente cómo un
      // presupuesto pasa en verde mientras la página engorda.
    }
  }

  let fallo = false;
  let pesado = false;
  console.log('Presupuesto de JavaScript de primera carga (T5.14)\n');
  for (const p of PRESUPUESTOS) {
    const { total, archivos, desconocidos, encontrada } = pesoDeRuta(
      p.ruta,
      manifiestoApp,
      manifiestoBuild,
      tamanos,
    );
    // Que la ruta no esté en el manifiesto NO es un aprobado: es que se
    // renombró o se movió, y el presupuesto dejó de vigilarla.
    const ok = encontrada && total <= p.limite && desconocidos.length === 0;
    if (!ok) fallo = true;
    if (encontrada && total > p.limite) pesado = true;
    console.log(
      `  ${ok ? '✔' : '✘'} ${p.nombre.padEnd(10)} ${kb(total).padStart(10)} ` +
        `/ ${kb(p.limite)}  (${archivos} trozos)`,
    );
    if (!encontrada) {
      console.log(
        `      «${p.ruta}» no está en la compilación. ¿Se renombró? ` +
          'Este presupuesto ya no vigila nada.',
      );
    }
    if (desconocidos.length > 0) {
      console.log(
        `      no se pudo medir: ${desconocidos.join(', ')} — el presupuesto NO es fiable`,
      );
    }
  }

  if (fallo) {
    console.error(
      pesado
        ? '\nEl presupuesto de rendimiento se ha superado.\n' +
            'Antes de subir el límite: mira qué se ha vuelto componente de cliente.\n' +
            'La tienda es de componentes de servidor salvo donde hay que reaccionar\n' +
            'a un clic, y cada `use client` nuevo arrastra su árbol al navegador.'
        : '\nEl presupuesto no se ha superado: es que ha dejado de poder medirse.\n' +
            'Arriba se detalla cuál de las rutas ya no encaja con la compilación.\n' +
            'Corrige la ruta en este guion para que vuelva a vigilar la página real.',
    );
    process.exit(1);
  }
  console.log('\nDentro de presupuesto.');
}

await main();
