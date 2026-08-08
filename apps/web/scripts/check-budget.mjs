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
  { ruta: '/carrito', nombre: 'carrito', limite: 200 * 1024 },
  { ruta: '/checkout', nombre: 'checkout', limite: 200 * 1024 },
];

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Suma el JS de primera carga de una ruta a partir de los manifiestos de la
 * compilación: los trozos comunes a toda la app más los propios de la página.
 */
function pesoDeRuta(ruta, manifiestoApp, manifiestoBuild, tamanos) {
  const archivos = new Set(manifiestoBuild.rootMainFiles ?? []);

  // En el App Router, las claves llevan el sufijo de segmento: `/page`,
  // `/carrito/page`. Se buscan las dos formas para no depender de la versión.
  const claves = [
    `${ruta === '/' ? '' : ruta}/page`,
    ruta,
    `${ruta === '/' ? '' : ruta}/layout`,
    '/layout',
  ];
  for (const clave of claves) {
    for (const archivo of manifiestoApp.pages?.[clave] ?? []) {
      archivos.add(archivo);
    }
  }

  let total = 0;
  const desconocidos = [];
  for (const archivo of archivos) {
    if (!archivo.endsWith('.js')) continue;
    const tam = tamanos.get(archivo);
    if (tam === undefined) desconocidos.push(archivo);
    else total += tam;
  }
  return { total, archivos: archivos.size, desconocidos };
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
  console.log('Presupuesto de JavaScript de primera carga (T5.14)\n');
  for (const p of PRESUPUESTOS) {
    const { total, archivos, desconocidos } = pesoDeRuta(
      p.ruta,
      manifiestoApp,
      manifiestoBuild,
      tamanos,
    );
    const ok = total <= p.limite && desconocidos.length === 0;
    if (!ok) fallo = true;
    console.log(
      `  ${ok ? '✔' : '✘'} ${p.nombre.padEnd(10)} ${kb(total).padStart(10)} ` +
        `/ ${kb(p.limite)}  (${archivos} trozos)`,
    );
    if (desconocidos.length > 0) {
      console.log(
        `      no se pudo medir: ${desconocidos.join(', ')} — el presupuesto NO es fiable`,
      );
    }
  }

  if (fallo) {
    console.error(
      '\nEl presupuesto de rendimiento se ha superado.\n' +
        'Antes de subir el límite: mira qué se ha vuelto componente de cliente.\n' +
        'La tienda es de componentes de servidor salvo donde hay que reaccionar\n' +
        'a un clic, y cada `use client` nuevo arrastra su árbol al navegador.',
    );
    process.exit(1);
  }
  console.log('\nDentro de presupuesto.');
}

await main();
