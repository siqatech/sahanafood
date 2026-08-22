import {
  enteroDeTexto,
  importeDeTexto,
  leerCsv,
  listaDeTexto,
  type FilaCsv,
} from './csv.js';

/**
 * Lectura de una carta desde CSV.
 *
 * Vive aparte de `import-csv.ts` —que es el guion de línea de comandos— porque
 * lo necesitan los dos: el guion, para transformar un Excel en `negocio.json`
 * antes de dar de alta un cliente, y el **panel**, para que el dueño pegue su
 * hoja sin salir de la pantalla (docs/26 §2).
 *
 * La razón de separarlo no es estética: `import-csv.ts` depende de
 * `business-setup.ts`, que a su vez conoce media aplicación. Importarlo desde
 * un módulo NestJS creaba un **ciclo** —catálogo → importador → alta de negocio
 * → tienda → catálogo— que `dependency-cruiser` rechaza, y con razón: un ciclo
 * es lo que convierte «toco el importador» en «se recompila todo».
 *
 * Aquí no hay nada de eso. Solo texto que entra y datos que salen, y por eso se
 * puede probar entero sin base de datos.
 *
 * Las reglas que importan son las del **Excel peruano**: separador `;`,
 * `45,90` con coma decimal, `S/` delante del importe, y un SKU repetido es un
 * ERROR y no «gana el último» — en una hoja de 180 líneas, quedarse con el
 * último hace desaparecer un producto sin que nadie lo note.
 */

/**
 * Un producto tal como sale de la hoja.
 *
 * Se declara aquí en vez de importarse de `business-setup.ts` justamente para
 * no arrastrar aquel grafo. Es estructuralmente el mismo objeto, y el guion lo
 * sigue usando donde espera el suyo.
 */
export interface ProductoDeCarta {
  sku?: string;
  nombre: string;
  descripcion?: string;
  categoria?: string;
  imagen?: string;
  alergenos?: string[];
  minutosPreparacion?: number;
  esCombo?: boolean;
  componentes?: Array<{ producto: string; cantidad: number }>;
  modificadores?: string[];
  /** Precios por canal; `base` es el que sirve a cualquier canal sin uno propio. */
  precios: Record<string, string>;
}

type Producto = ProductoDeCarta;

/** Alias de cabecera aceptados: la hoja la escribe una persona, no un esquema. */
export const ALIAS: Record<string, string> = {
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

export function valor(fila: FilaCsv, columna: string): string {
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

export function exigir(
  fila: FilaCsv,
  columna: string,
  archivo: string,
): string {
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
export function esSi(texto: string): boolean {
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
export function componentesDeTexto(
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
