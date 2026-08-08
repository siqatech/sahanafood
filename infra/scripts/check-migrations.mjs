#!/usr/bin/env node
/**
 * Gate de compatibilidad de migraciones (docs/17, T5.35).
 *
 * El criterio de la fase es que **un despliegue malo se revierte sin tocar la
 * base de datos**, y eso no depende del despliegue: depende de las
 * migraciones. Si una migración borra una columna que la versión anterior lee,
 * volver a la imagen anterior deja el sistema roto igual, y entonces el
 * rollback exige restaurar un backup — con los pedidos de la última hora
 * dentro.
 *
 * De ahí la regla de docs/17: **expand → migrate → contract, nunca romper en
 * un paso**. Este script la convierte en un gate. Sin él, la regla es una
 * frase en un documento que se incumple el primer martes con prisa, y nadie lo
 * nota hasta que hace falta revertir.
 *
 * Lo que rechaza:
 *
 *  · `DROP TABLE`, `DROP COLUMN`, `RENAME` y cambios de tipo: la versión
 *    anterior sigue leyendo lo que ya no está.
 *  · `ADD COLUMN ... NOT NULL` sin `DEFAULT`: los `INSERT` de la versión
 *    anterior no mandan esa columna y empiezan a fallar en el acto.
 *  · `DROP` de políticas RLS: dejaría una tabla de negocio sin aislamiento, que
 *    es peor que un despliegue roto.
 *
 * Cómo se hace una contracción: en una migración POSTERIOR, cuando ya no queda
 * ninguna versión desplegada que use lo que se va a borrar. Se declara con una
 * cabecera explícita:
 *
 *     -- fase: contract
 *     -- expande: 0012_catalog_versions.sql
 *
 * Declararlo no es un trámite: obliga a escribir contra qué versión se está
 * contrayendo, que es justo la comprobación que nadie hace de memoria.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Reglas. Cada una explica QUÉ rompe, no solo qué prohíbe: un gate que dice
 * «no puedes» sin decir por qué se acaba sorteando con un comentario mágico.
 */
const REGLAS = [
  {
    nombre: 'DROP TABLE',
    re: /\bDROP\s+TABLE\b/i,
    rompe: 'la versión anterior sigue consultando esa tabla',
  },
  {
    nombre: 'DROP COLUMN',
    re: /\bDROP\s+COLUMN\b/i,
    rompe: 'la versión anterior sigue leyendo esa columna',
  },
  {
    nombre: 'RENAME',
    re: /\bRENAME\s+(?:TO|COLUMN|CONSTRAINT)\b/i,
    rompe: 'un renombrado es un DROP y un ADD a la vez para quien no lo sabe',
  },
  {
    nombre: 'ALTER COLUMN ... TYPE',
    re: /\bALTER\s+COLUMN\s+\w+\s+(?:SET\s+DATA\s+)?TYPE\b/i,
    rompe: 'la versión anterior escribe con el tipo viejo',
  },
  {
    nombre: 'DROP POLICY',
    re: /\bDROP\s+POLICY\b/i,
    rompe: 'dejaría una tabla de negocio sin aislamiento por tenant',
  },
  {
    nombre: 'DROP NOT NULL inverso (SET NOT NULL)',
    re: /\bALTER\s+COLUMN\s+\w+\s+SET\s+NOT\s+NULL\b/i,
    rompe: 'los INSERT de la versión anterior no mandan esa columna',
  },
];

/** `ADD COLUMN x type NOT NULL` sin `DEFAULT` en la misma sentencia. */
const ADD_COLUMN = /\bADD\s+COLUMN\b[^;]*?;/gis;

async function main() {
  const archivos = (await readdir(DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const problemas = [];

  for (const archivo of archivos) {
    const sql = await readFile(join(DIR, archivo), 'utf8');
    const cabecera = sql.slice(0, 2000);
    const esContraccion = /--\s*fase:\s*contract\b/i.test(cabecera);
    const declaraExpansion = /--\s*expande:\s*\S+\.sql/i.test(cabecera);

    if (esContraccion && !declaraExpansion) {
      problemas.push(
        `${archivo}: declara "fase: contract" pero no dice contra qué expansión ` +
          '(falta la línea "-- expande: NNNN_....sql"). Sin eso nadie puede ' +
          'comprobar que ya no queda una versión desplegada usando lo que se borra.',
      );
    }

    // Se ignoran los comentarios: media migración de este repo es prosa, y
    // «no usamos DROP TABLE» dentro de un comentario no es un DROP TABLE.
    const codigo = sinComentarios(sql);

    for (const regla of REGLAS) {
      if (regla.re.test(codigo) && !esContraccion) {
        problemas.push(
          `${archivo}: usa ${regla.nombre} fuera de una fase de contracción — ${regla.rompe}. ` +
            'Si de verdad toca contraer, márcala con "-- fase: contract" y ' +
            '"-- expande: <migración>".',
        );
      }
    }

    for (const sentencia of codigo.match(ADD_COLUMN) ?? []) {
      const notNull = /\bNOT\s+NULL\b/i.test(sentencia);
      const conDefault = /\bDEFAULT\b/i.test(sentencia);
      if (notNull && !conDefault) {
        problemas.push(
          `${archivo}: añade una columna NOT NULL sin DEFAULT. Los INSERT de la ` +
            'versión anterior no mandan esa columna y fallarían durante el ' +
            'despliegue, que es exactamente cuando conviven las dos versiones.',
        );
      }
    }
  }

  if (problemas.length > 0) {
    console.error(
      '\nMigraciones incompatibles con un rollback sin tocar la base:\n',
    );
    for (const p of problemas) console.error(`  ✘ ${p}`);
    console.error(
      '\nRegla de docs/17: expand → migrate → contract, nunca romper en un paso.\n',
    );
    process.exit(1);
  }

  console.error(
    `Migraciones revisadas: ${archivos.length}. Todas admiten volver a la imagen anterior.`,
  );
}

/** Quita `--` de línea y `/* *\/` de bloque. */
function sinComentarios(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((linea) => linea.replace(/--.*$/, ''))
    .join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
