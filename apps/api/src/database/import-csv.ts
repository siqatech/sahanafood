import { readFileSync, writeFileSync } from 'node:fs';
import {
  cantidadDeTexto,
  enteroDeTexto,
  importeDeTexto,
  leerCsv,
  listaDeTexto,
  type FilaCsv,
} from './csv.js';
import type { DescripcionNegocio } from './business-setup.js';

/**
 * Importador de carta e inventario **desde CSV**.
 *
 *   node dist/database/import-csv.js \
 *     --negocio negocio.json --productos carta.csv \
 *     [--insumos insumos.csv] [--recetas recetas.csv] \
 *     [--marca "Pollería El Buen Sabor"] --salida negocio-final.json
 *
 * Por qué existe: dar de alta un cliente pasa hoy por un JSON escrito a mano.
 * Funciona y está probado de punta a punta, pero un dueño con 180 productos los
 * tiene en un Excel, y quien le pase ese Excel a JSON tarda una tarde. Es lo
 * que separa dar de alta a diez clientes de dar de alta a uno.
 *
 * Y por qué es una TRANSFORMACIÓN DE ARCHIVOS y no un alta contra la base:
 *
 *  · **No duplica ninguna regla.** El resultado es el mismo `negocio.json` que
 *    aplica `setup-business.js`, que es idempotente y se ejerce en CI contra el
 *    ejemplo del repositorio. Un segundo camino de escritura al catálogo sería
 *    un segundo sitio donde los precios pueden salir distintos.
 *  · **Se puede revisar antes de aplicar.** Importar 180 productos de una hoja
 *    que hizo otra persona y que se apliquen sin que nadie los mire es cómo se
 *    publica una carta con un cero de más.
 *  · Se prueba entero sin base de datos, así que las pruebas son de verdad.
 *
 * Los errores nombran **fila y columna**. Una importación de 180 líneas que
 * falla diciendo «importe inválido» y nada más no se puede arreglar.
 */

type Carta = NonNullable<DescripcionNegocio['carta']>[number];
type Producto = Carta['productos'][number];
type Inventario = NonNullable<DescripcionNegocio['inventario']>;

/** Alias de cabecera aceptados: la hoja la escribe una persona, no un esquema. */
const ALIAS: Record<string, string> = {
  producto: 'nombre',
  plato: 'nombre',
  codigo: 'sku',
  código: 'sku',
  precio: 'precio_base',
  categoría: 'categoria',
  descripción: 'descripcion',
  alérgenos: 'alergenos',
  preparacion: 'minutos_preparacion',
  minutos: 'minutos_preparacion',
  unidad_de_medida: 'unidad',
  costo: 'costo_unitario',
  merma: 'merma_bps',
};

function valor(fila: FilaCsv, columna: string): string {
  const directo = fila.valores[columna];
  if (directo !== undefined) return directo;
  for (const [alias, real] of Object.entries(ALIAS)) {
    if (real === columna) {
      const v = fila.valores[alias];
      if (v !== undefined) return v;
    }
  }
  return '';
}

function exigir(fila: FilaCsv, columna: string, archivo: string): string {
  const v = valor(fila, columna);
  if (v === '') {
    throw new Error(
      `${archivo}, fila ${fila.linea}: falta «${columna}», que es obligatoria.`,
    );
  }
  return v;
}

/**
 * Columnas de precio: cualquiera que empiece por `precio_`.
 *
 * `precio_base` es el precio que sirve a cualquier canal sin uno propio;
 * `precio_web`, `precio_pos`, `precio_rappi`… son el precio de ese canal. Así
 * añadir un canal es añadir una columna, sin tocar el importador.
 */
function preciosDeFila(fila: FilaCsv, archivo: string): Record<string, string> {
  const precios: Record<string, string> = {};
  for (const [columna, texto] of Object.entries(fila.valores)) {
    if (!columna.startsWith('precio_') || texto === '') continue;
    const canal = columna.slice('precio_'.length);
    precios[canal] = importeDeTexto(
      texto,
      `${archivo}, fila ${fila.linea}, columna «${columna}»`,
    );
  }
  // Alias `precio` a secas → `base`.
  const suelto = fila.valores['precio'];
  if (suelto !== undefined && suelto !== '' && precios['base'] === undefined) {
    precios['base'] = importeDeTexto(
      suelto,
      `${archivo}, fila ${fila.linea}, columna «precio»`,
    );
  }
  return precios;
}

/** «sí», «si», «true», «1», «x» — lo que escribe alguien en una hoja. */
function esSi(texto: string): boolean {
  return ['si', 'sí', 'true', '1', 'x', 'verdadero'].includes(
    texto.trim().toLowerCase(),
  );
}

/**
 * Componentes de un combo, dentro de una celda: `POLLO-ENT x1 | GASEOSA-15 x1`.
 *
 * La cantidad es obligatoria y explícita. Dar por hecho «x1» cuando falta
 * parece amable y convierte un combo familiar de dos pollos en uno de uno, que
 * es una pérdida por cada venta y no da ningún error.
 */
function componentesDeTexto(
  texto: string,
  donde: string,
): Array<{ producto: string; cantidad: number }> {
  return listaDeTexto(texto).map((parte) => {
    const coincide = /^(.+?)\s*[x*]\s*(\d+)$/i.exec(parte.trim());
    if (!coincide) {
      throw new Error(
        `${donde}: «${parte}» no es un componente. Se esperaba «SKU x CANTIDAD», ` +
          'por ejemplo «POLLO-ENT x1», y varios separados por «|».',
      );
    }
    return { producto: coincide[1]!.trim(), cantidad: Number(coincide[2]) };
  });
}

export function productosDeCsv(
  contenido: string,
  archivo = 'productos',
): {
  productos: Producto[];
  categorias: Array<{ nombre: string; orden: number }>;
} {
  const { filas } = leerCsv(contenido);
  const productos: Producto[] = [];
  const categorias = new Map<string, number>();
  const vistos = new Map<string, number>();

  for (const fila of filas) {
    const nombre = exigir(fila, 'nombre', archivo);
    const sku = valor(fila, 'sku');

    // Un SKU repetido no se resuelve quedándose con el último: en una hoja de
    // 180 líneas eso es un producto que desaparece sin que nadie lo note.
    const clave = (
      sku !== '' ? `sku:${sku}` : `nombre:${nombre}`
    ).toLowerCase();
    const anterior = vistos.get(clave);
    if (anterior !== undefined) {
      throw new Error(
        `${archivo}, fila ${fila.linea}: «${sku !== '' ? sku : nombre}» ya estaba en la fila ${anterior}.`,
      );
    }
    vistos.set(clave, fila.linea);

    const precios = preciosDeFila(fila, archivo);
    if (Object.keys(precios).length === 0) {
      throw new Error(
        `${archivo}, fila ${fila.linea}: «${nombre}» no tiene ningún precio. ` +
          'Se esperaba al menos una columna «precio_base» (o «precio»).',
      );
    }

    const categoria = valor(fila, 'categoria');
    if (categoria !== '' && !categorias.has(categoria)) {
      categorias.set(categoria, categorias.size + 1);
    }

    const componentes = componentesDeTexto(
      valor(fila, 'componentes'),
      `${archivo}, fila ${fila.linea}`,
    );
    const esCombo = esSi(valor(fila, 'es_combo')) || componentes.length > 0;
    if (esCombo && componentes.length === 0) {
      throw new Error(
        `${archivo}, fila ${fila.linea}: «${nombre}» está marcado como combo y no ` +
          'declara «componentes». Un combo sin componentes se publica como un ' +
          'producto vacío que se puede pedir.',
      );
    }

    const descripcion = valor(fila, 'descripcion');
    const imagen = valor(fila, 'imagen');
    const alergenos = listaDeTexto(valor(fila, 'alergenos'));
    const modificadores = listaDeTexto(valor(fila, 'modificadores'));
    const minutos = valor(fila, 'minutos_preparacion');

    productos.push({
      nombre,
      precios,
      ...(sku !== '' ? { sku } : {}),
      ...(descripcion !== '' ? { descripcion } : {}),
      ...(categoria !== '' ? { categoria } : {}),
      ...(imagen !== '' ? { imagen } : {}),
      ...(alergenos.length > 0 ? { alergenos } : {}),
      ...(modificadores.length > 0 ? { modificadores } : {}),
      ...(minutos !== ''
        ? {
            minutosPreparacion: enteroDeTexto(
              minutos,
              `${archivo}, fila ${fila.linea}, columna «minutos_preparacion»`,
            ),
          }
        : {}),
      ...(esCombo ? { esCombo: true, componentes } : {}),
    });
  }

  if (productos.length === 0) {
    throw new Error(`${archivo}: no tiene ninguna fila de producto.`);
  }

  return {
    productos,
    categorias: [...categorias].map(([nombre, orden]) => ({ nombre, orden })),
  };
}

export function insumosDeCsv(
  contenido: string,
  archivo = 'insumos',
): Inventario['insumos'] {
  const { filas } = leerCsv(contenido);
  return filas.map((fila) => {
    const nombre = exigir(fila, 'nombre', archivo);
    const unidad = exigir(fila, 'unidad', archivo);
    const sku = valor(fila, 'sku');
    const costo = valor(fila, 'costo_unitario');
    const minimo = valor(fila, 'minimo');

    return {
      nombre,
      unidad,
      ...(sku !== '' ? { sku } : {}),
      // El costo va POR UNIDAD —por gramo, no por kilo—, igual que en el JSON.
      // Es el error de captura más caro del alta: un food cost mil veces mayor
      // se lee como que todo pierde dinero.
      ...(costo !== ''
        ? {
            costoUnitario: importeDeTexto(
              costo,
              `${archivo}, fila ${fila.linea}, columna «costo_unitario»`,
            ),
          }
        : {}),
      ...(minimo !== ''
        ? {
            minimo: cantidadDeTexto(
              minimo,
              `${archivo}, fila ${fila.linea}, columna «minimo»`,
            ),
          }
        : {}),
    };
  });
}

/**
 * Recetas en formato LARGO: una línea por ingrediente.
 *
 * Es como sale de un Excel —una fila por cosa— y evita el formato ancho, que
 * obligaría a una columna por ingrediente y se rompe con la primera receta que
 * tenga uno más.
 */
export function recetasDeCsv(
  contenido: string,
  archivo = 'recetas',
): NonNullable<Inventario['recetas']> {
  const { filas } = leerCsv(contenido);
  const porNombre = new Map<
    string,
    NonNullable<Inventario['recetas']>[number]
  >();

  for (const fila of filas) {
    const receta = exigir(fila, 'receta', archivo);
    const insumo = valor(fila, 'insumo');
    const subreceta = valor(fila, 'subreceta');

    if (insumo === '' && subreceta === '') {
      throw new Error(
        `${archivo}, fila ${fila.linea}: la receta «${receta}» necesita un «insumo» o una «subreceta».`,
      );
    }
    if (insumo !== '' && subreceta !== '') {
      throw new Error(
        `${archivo}, fila ${fila.linea}: «${receta}» declara insumo Y subreceta a la vez; es uno de los dos.`,
      );
    }

    let actual = porNombre.get(receta);
    if (actual === undefined) {
      const producto = valor(fila, 'producto');
      const rendimiento = valor(fila, 'rendimiento');
      const unidadRendimiento = valor(fila, 'unidad_rendimiento');
      actual = {
        nombre: receta,
        componentes: [],
        ...(producto !== '' ? { producto } : {}),
        ...(rendimiento !== ''
          ? {
              rendimiento: cantidadDeTexto(
                rendimiento,
                `${archivo}, fila ${fila.linea}, columna «rendimiento»`,
              ),
            }
          : {}),
        ...(unidadRendimiento !== '' ? { unidadRendimiento } : {}),
      };
      porNombre.set(receta, actual);
    }

    const merma = valor(fila, 'merma_bps');
    actual.componentes.push({
      cantidad: cantidadDeTexto(
        exigir(fila, 'cantidad', archivo),
        `${archivo}, fila ${fila.linea}, columna «cantidad»`,
      ),
      ...(insumo !== '' ? { insumo } : {}),
      ...(subreceta !== '' ? { receta: subreceta } : {}),
      // La merma va en puntos básicos ENTEROS: 5 % = 500. Aceptar «5» como 5 %
      // sería adivinar, y adivinar aquí desplaza el food cost de todo el
      // negocio en dos órdenes de magnitud.
      ...(merma !== ''
        ? {
            mermaBps: enteroDeTexto(
              merma,
              `${archivo}, fila ${fila.linea}, columna «merma_bps»`,
            ),
          }
        : {}),
    });
  }

  return [...porNombre.values()];
}

export interface EntradaImportacion {
  negocio: DescripcionNegocio;
  productosCsv: string;
  insumosCsv?: string;
  recetasCsv?: string;
  /** Marca a la que va la carta. Si el negocio tiene una sola, se deduce. */
  marca?: string;
}

export interface ResumenImportacion {
  negocio: DescripcionNegocio;
  marca: string;
  productos: number;
  categorias: number;
  insumos: number;
  recetas: number;
}

export function importar(entrada: EntradaImportacion): ResumenImportacion {
  const marcas = entrada.negocio.marcas ?? [];
  if (marcas.length === 0) {
    throw new Error(
      'El negocio no declara ninguna marca; la carta tiene que colgar de una.',
    );
  }

  let marca = entrada.marca?.trim() ?? '';
  if (marca === '') {
    if (marcas.length > 1) {
      throw new Error(
        `El negocio tiene ${marcas.length} marcas (${marcas
          .map((m) => m.nombre)
          .join(', ')}). Indica a cuál va la carta con --marca.`,
      );
    }
    marca = marcas[0]!.nombre;
  } else if (
    !marcas.some(
      (m) =>
        m.nombre.toLowerCase() === marca.toLowerCase() ||
        m.slug?.toLowerCase() === marca.toLowerCase(),
    )
  ) {
    throw new Error(
      `La marca «${marca}» no está en el negocio. Las que hay: ${marcas
        .map((m) => m.nombre)
        .join(', ')}.`,
    );
  }

  const { productos, categorias } = productosDeCsv(entrada.productosCsv);

  // Los grupos de modificadores NO se importan por CSV: son estructura (mínimo,
  // máximo, si repite) y no se dejan describir en una fila sin inventar una
  // sintaxis dentro de una celda. Se declaran en el JSON y la hoja solo los
  // referencia por nombre; comprobamos aquí que existan, porque un nombre mal
  // escrito dejaría el plato sin sus extras y eso se descubre vendiendo.
  const cartaPrevia = entrada.negocio.carta?.find(
    (c) => c.marca.toLowerCase() === marca.toLowerCase(),
  );
  const gruposConocidos = new Set(
    (cartaPrevia?.gruposModificadores ?? []).map((g) => g.nombre.toLowerCase()),
  );
  for (const producto of productos) {
    for (const grupo of producto.modificadores ?? []) {
      if (!gruposConocidos.has(grupo.toLowerCase())) {
        throw new Error(
          `El producto «${producto.nombre}» usa el grupo de modificadores «${grupo}», ` +
            'que no está declarado en el negocio. Los grupos se describen en el JSON ' +
            '(nombre, mínimo, máximo y opciones) y la hoja solo los nombra.',
        );
      }
    }
  }

  const inventario = entrada.insumosCsv
    ? {
        insumos: insumosDeCsv(entrada.insumosCsv),
        ...(entrada.recetasCsv
          ? { recetas: recetasDeCsv(entrada.recetasCsv) }
          : {}),
      }
    : undefined;

  // Las categorías previas mandan: si el JSON ya las ordenó a mano, la hoja no
  // debe reordenarlas por el orden en que aparecieron los productos.
  const categoriasPrevias = cartaPrevia?.categorias ?? [];
  const nombresPrevios = new Set(
    categoriasPrevias.map((c) => c.nombre.toLowerCase()),
  );
  const categoriasFinales = [
    ...categoriasPrevias,
    ...categorias.filter((c) => !nombresPrevios.has(c.nombre.toLowerCase())),
  ];

  const cartaNueva: Carta = {
    marca,
    productos,
    ...(categoriasFinales.length > 0 ? { categorias: categoriasFinales } : {}),
    ...(cartaPrevia?.gruposModificadores
      ? { gruposModificadores: cartaPrevia.gruposModificadores }
      : {}),
  };

  const negocio: DescripcionNegocio = {
    ...entrada.negocio,
    carta: [
      ...(entrada.negocio.carta ?? []).filter(
        (c) => c.marca.toLowerCase() !== marca.toLowerCase(),
      ),
      cartaNueva,
    ],
    ...(inventario ? { inventario } : {}),
  };

  return {
    negocio,
    marca,
    productos: productos.length,
    categorias: categoriasFinales.length,
    insumos: inventario?.insumos.length ?? 0,
    recetas: inventario?.recetas?.length ?? 0,
  };
}

// ---------------------------------------------------------------- Comando

/**
 * Lee `--clave valor`, sin dar por hecho que vengan de dos en dos.
 *
 * Recorrer el vector a saltos de dos parece equivalente y no lo es: `pnpm run`
 * intercala un `--` antes de los argumentos, y ese único elemento de más
 * desplaza todos los pares. El resultado es que **no se lee ninguna opción** y
 * el comando responde con el modo de uso como si no le hubieras pasado nada.
 * Acepta también `--clave=valor`.
 */
function leerArgumentos(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--') || token === '--') {
      continue;
    }
    const igual = token.indexOf('=');
    if (igual > 2) {
      args[token.slice(2, igual)] = token.slice(igual + 1);
      continue;
    }
    const siguiente = argv[i + 1];
    if (siguiente !== undefined && !siguiente.startsWith('--')) {
      args[token.slice(2)] = siguiente;
      i += 1;
    }
  }
  return args;
}

const USO =
  'Uso:\n' +
  '  node dist/database/import-csv.js \\\n' +
  '    --negocio negocio.json --productos carta.csv \\\n' +
  '    [--insumos insumos.csv] [--recetas recetas.csv] \\\n' +
  '    [--marca "Nombre de la marca"] --salida negocio-final.json\n\n' +
  'Produce el negocio.json que aplica `setup-business.js`. Revísalo antes de\n' +
  'aplicarlo: es la carta que van a ver los clientes.\n\n' +
  'Hay hojas de ejemplo en infra/ejemplos/.';

function main(): void {
  const args = leerArgumentos(process.argv.slice(2));
  const negocioRuta = args['negocio'];
  const productosRuta = args['productos'];
  const salida = args['salida'];

  if (!negocioRuta || !productosRuta || !salida) {
    throw new Error(USO);
  }

  const resumen = importar({
    negocio: JSON.parse(
      readFileSync(negocioRuta, 'utf8'),
    ) as DescripcionNegocio,
    productosCsv: readFileSync(productosRuta, 'utf8'),
    ...(args['insumos']
      ? { insumosCsv: readFileSync(args['insumos'], 'utf8') }
      : {}),
    ...(args['recetas']
      ? { recetasCsv: readFileSync(args['recetas'], 'utf8') }
      : {}),
    ...(args['marca'] ? { marca: args['marca'] } : {}),
  });

  writeFileSync(salida, `${JSON.stringify(resumen.negocio, null, 2)}\n`);

  process.stderr.write(
    `Marca: ${resumen.marca}\n` +
      `Productos: ${resumen.productos}\n` +
      `Categorías: ${resumen.categorias}\n` +
      `Insumos: ${resumen.insumos}\n` +
      `Recetas: ${resumen.recetas}\n\n` +
      `Escrito en ${salida}.\n` +
      'REVÍSALO antes de aplicarlo con setup-business.js: los precios de ese\n' +
      'archivo son los que se van a cobrar.\n',
  );
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('import-csv.js') ||
    process.argv[1].endsWith('import-csv.ts'))
) {
  try {
    main();
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
