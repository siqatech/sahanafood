import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leerCsv, importeDeTexto } from './csv.js';
import {
  importar,
  insumosDeCsv,
  productosDeCsv,
  recetasDeCsv,
} from './import-csv.js';
import type { DescripcionNegocio } from './business-setup.js';

/**
 * Importación de carta desde CSV.
 *
 * Lo que se comprueba aquí no es «lee un CSV» —eso lo hace cualquier cosa— sino
 * las formas de leerlo MAL que no dan error: el separador de Excel en español,
 * la coma decimal, el BOM y el SKU repetido. Las cuatro producen un archivo que
 * se aplica sin quejarse y una carta equivocada.
 */

const NEGOCIO_BASE: DescripcionNegocio = {
  empresa: { razonSocial: 'Pollería El Buen Sabor S.A.C.', ruc: '20512345678' },
  marcas: [{ nombre: 'El Buen Sabor', slug: 'buen-sabor' }],
  locales: [{ nombre: 'Surquillo', direccion: 'Av. Angamos 123' }],
};

describe('Lectura de CSV', () => {
  it('EXCEL EN ESPAÑOL exporta con «;» y coma decimal, y eso se lee bien', () => {
    // Es el caso normal, no el raro: un dueño peruano exportando su hoja.
    const csv = 'nombre;categoria;precio_base\nPollo a la brasa;Pollos;45,90\n';
    const { separador, filas } = leerCsv(csv);
    expect(separador).toBe(';');
    expect(filas[0]!.valores['precio_base']).toBe('45,90');

    const { productos } = productosDeCsv(csv);
    expect(productos[0]!.precios['base']).toBe('45.90');
  });

  it('EL BOM de Excel no deja la primera columna sin nombre', () => {
    // Sin quitarlo, la cabecera es «\ufeff + nombre» y el archivo parece no tener
    // columna «nombre»: falla con «falta nombre» en todas las filas. Va escrito
    // como escape a propósito — el carácter literal es invisible, y una prueba
    // cuyo caso no se ve en el código no se puede revisar.
    const csv = '\ufeffnombre,precio_base\nInca Kola 500ml,5.50\n';
    const { productos } = productosDeCsv(csv);
    expect(productos[0]!.nombre).toBe('Inca Kola 500ml');
  });

  it('LAS COMILLAS protegen comas y saltos dentro de una celda', () => {
    const csv =
      'nombre,descripcion,precio_base\n' +
      '"Combo ""El Grande""","Pollo, papas y ensalada",59.90\n';
    const { productos } = productosDeCsv(csv);
    expect(productos[0]!.nombre).toBe('Combo "El Grande"');
    expect(productos[0]!.descripcion).toBe('Pollo, papas y ensalada');
  });

  it('LAS FILAS EN BLANCO del final de un Excel se ignoran', () => {
    const csv = 'nombre,precio_base\nPollo,45.90\n,\n\n,\n';
    expect(productosDeCsv(csv).productos).toHaveLength(1);
  });
});

describe('Importes', () => {
  it('DISTINGUE separador de miles y decimal por cuál va al final', () => {
    expect(importeDeTexto('1.500,00', 'x')).toBe('1500.00'); // es-PE
    expect(importeDeTexto('1,500.00', 'x')).toBe('1500.00'); // en-US
    expect(importeDeTexto('45,90', 'x')).toBe('45.90');
    expect(importeDeTexto('45.90', 'x')).toBe('45.90');
    expect(importeDeTexto('S/ 12.50', 'x')).toBe('12.50');
  });

  it('RECHAZA lo que no es un importe, diciendo dónde', () => {
    expect(() => importeDeTexto('carísimo', 'carta, fila 7')).toThrow(
      /carta, fila 7/,
    );
    expect(() => importeDeTexto('-5.00', 'x')).toThrow(/negativo/);
    // Más de cuatro decimales: la base guarda NUMERIC(14,4) y redondear en
    // silencio es cambiarle el precio a alguien.
    expect(() => importeDeTexto('12.123456', 'x')).toThrow(/importe/);
  });
});

describe('Productos', () => {
  it('CADA COLUMNA «precio_*» es un canal, y así añadir uno es añadir columna', () => {
    const csv =
      'sku,nombre,precio_base,precio_web,precio_rappi\n' +
      'POLLO-1,Pollo entero,45.90,47.90,59.90\n';
    const { productos } = productosDeCsv(csv);
    expect(productos[0]!.precios).toEqual({
      base: '45.90',
      web: '47.90',
      rappi: '59.90',
    });
  });

  it('UN SKU REPETIDO es un error, no el último gana', () => {
    // Quedarse con el último hace desaparecer un producto de una hoja de 180
    // líneas sin que nadie lo note hasta que un cliente lo pide.
    const csv =
      'sku,nombre,precio_base\n' +
      'POLLO-1,Pollo entero,45.90\n' +
      'POLLO-1,Pollo a la brasa,45.90\n';
    expect(() => productosDeCsv(csv)).toThrow(/fila 3.*ya estaba en la fila 2/);
  });

  it('UN PRODUCTO SIN PRECIO no pasa: sin precio no se puede vender', () => {
    expect(() => productosDeCsv('nombre,categoria\nPollo,Pollos\n')).toThrow(
      /no tiene ningún precio/,
    );
  });

  it('ACEPTA los nombres de columna que escribiría una persona', () => {
    const csv = 'producto,precio\nPollo a la brasa,45.90\n';
    const { productos } = productosDeCsv(csv);
    expect(productos[0]!.nombre).toBe('Pollo a la brasa');
    expect(productos[0]!.precios['base']).toBe('45.90');
  });

  it('LAS CATEGORÍAS salen en el orden en que aparecen', () => {
    const csv =
      'nombre,categoria,precio_base\n' +
      'Pollo,Pollos,45.90\n' +
      'Inca Kola,Bebidas,5.50\n' +
      'Brasa,Pollos,25.00\n';
    expect(productosDeCsv(csv).categorias).toEqual([
      { nombre: 'Pollos', orden: 1 },
      { nombre: 'Bebidas', orden: 2 },
    ]);
  });
});

describe('Insumos y recetas', () => {
  it('EL COSTO va por unidad y admite cuatro decimales', () => {
    const csv = 'sku,nombre,unidad,costo_unitario\nPOLLO,Pollo,g,0.0120\n';
    expect(insumosDeCsv(csv)[0]).toEqual({
      sku: 'POLLO',
      nombre: 'Pollo',
      unidad: 'g',
      costoUnitario: '0.0120',
    });
  });

  it('LAS RECETAS van en formato largo: una fila por ingrediente', () => {
    const csv =
      'receta,producto,insumo,cantidad,merma_bps\n' +
      'Pollo a la brasa,POLLO-1,POLLO,1200,500\n' +
      'Pollo a la brasa,POLLO-1,SAL,20,\n';
    const recetas = recetasDeCsv(csv);
    expect(recetas).toHaveLength(1);
    expect(recetas[0]!.producto).toBe('POLLO-1');
    expect(recetas[0]!.componentes).toEqual([
      { insumo: 'POLLO', cantidad: '1200', mermaBps: 500 },
      { insumo: 'SAL', cantidad: '20' },
    ]);
  });

  it('UNA SUBRECETA se declara como tal, y no junto a un insumo', () => {
    const csv =
      'receta,insumo,subreceta,cantidad\n' + 'Combo,POLLO,Crema,100\n';
    expect(() => recetasDeCsv(csv)).toThrow(/insumo Y subreceta/);
  });
});

describe('Importación completa', () => {
  const PRODUCTOS =
    'sku;nombre;categoria;precio_base;precio_web\n' +
    'POLLO-1;Pollo a la brasa;Pollos;45,90;47,90\n' +
    'IK-500;Inca Kola 500ml;Bebidas;5,50;6,00\n';

  it('PRODUCE el mismo negocio.json que aplica setup-business', () => {
    const r = importar({ negocio: NEGOCIO_BASE, productosCsv: PRODUCTOS });

    expect(r.marca).toBe('El Buen Sabor');
    expect(r.productos).toBe(2);
    // La empresa y los locales se conservan intactos: el CSV solo trae carta.
    expect(r.negocio.empresa).toEqual(NEGOCIO_BASE.empresa);
    expect(r.negocio.locales).toEqual(NEGOCIO_BASE.locales);
    expect(r.negocio.carta![0]!.productos[0]!.precios).toEqual({
      base: '45.90',
      web: '47.90',
    });
  });

  it('CON VARIAS MARCAS exige decir a cuál va la carta', () => {
    const dos: DescripcionNegocio = {
      ...NEGOCIO_BASE,
      marcas: [{ nombre: 'El Buen Sabor' }, { nombre: 'Sabor Wok' }],
    };
    expect(() => importar({ negocio: dos, productosCsv: PRODUCTOS })).toThrow(
      /--marca/,
    );
    expect(
      importar({ negocio: dos, productosCsv: PRODUCTOS, marca: 'Sabor Wok' })
        .marca,
    ).toBe('Sabor Wok');
  });

  it('UNA MARCA QUE NO EXISTE se nombra, con las que sí hay', () => {
    expect(() =>
      importar({
        negocio: NEGOCIO_BASE,
        productosCsv: PRODUCTOS,
        marca: 'Pollería Fantasma',
      }),
    ).toThrow(/El Buen Sabor/);
  });

  it('UN GRUPO DE MODIFICADORES mal escrito se detecta ANTES de aplicar', () => {
    // Si no, el plato se crea sin sus extras: se vende un pollo sin poder
    // elegir la guarnición y se descubre con el cliente delante.
    const conGrupos: DescripcionNegocio = {
      ...NEGOCIO_BASE,
      carta: [
        {
          marca: 'El Buen Sabor',
          gruposModificadores: [
            { nombre: 'Guarniciones', opciones: [{ nombre: 'Papas' }] },
          ],
          productos: [],
        },
      ],
    };
    const csv = 'nombre,precio_base,modificadores\nPollo,45.90,Guarnicion\n';
    expect(() => importar({ negocio: conGrupos, productosCsv: csv })).toThrow(
      /Guarnicion/,
    );

    // Bien escrito, pasa y conserva los grupos declarados en el JSON.
    const bien = 'nombre,precio_base,modificadores\nPollo,45.90,Guarniciones\n';
    const r = importar({ negocio: conGrupos, productosCsv: bien });
    expect(r.negocio.carta![0]!.gruposModificadores).toHaveLength(1);
  });

  it('REEMPLAZA la carta de esa marca y deja en paz las demás', () => {
    // Reimportar es la forma de corregir un precio mal escrito, así que tiene
    // que ser repetible sin duplicar nada.
    const dos: DescripcionNegocio = {
      ...NEGOCIO_BASE,
      marcas: [{ nombre: 'El Buen Sabor' }, { nombre: 'Sabor Wok' }],
      carta: [
        {
          marca: 'Sabor Wok',
          productos: [{ nombre: 'Arroz chaufa', precios: { base: '22.00' } }],
        },
      ],
    };
    const r = importar({
      negocio: dos,
      productosCsv: PRODUCTOS,
      marca: 'El Buen Sabor',
    });
    expect(r.negocio.carta).toHaveLength(2);
    const wok = r.negocio.carta!.find((c) => c.marca === 'Sabor Wok');
    expect(wok!.productos[0]!.nombre).toBe('Arroz chaufa');
  });
});

describe('Las hojas de ejemplo del repositorio', () => {
  /**
   * La prueba que de verdad vale: el CSV de ejemplo tiene que producir la
   * MISMA carta y el MISMO inventario que `negocio.ejemplo.json`.
   *
   * Ese JSON no es un archivo cualquiera — `setup-business-e2e` lo aplica en CI
   * de punta a punta: monta el negocio, pide un pedido, comprueba que cobra el
   * precio del archivo y que el kardex descuenta lo que dice la receta. Si el
   * importador reproduce ese archivo exactamente, entonces el camino del CSV
   * hereda esa verificación entera en vez de tener una propia y más floja.
   *
   * Y de paso obliga a que las hojas de ejemplo estén bien: un ejemplo que
   * nadie ha ejecutado se descubre roto con el cliente delante.
   */
  const raiz = join(process.cwd(), '..', '..', 'infra', 'ejemplos');
  const leer = (n: string): string => readFileSync(join(raiz, n), 'utf8');

  /** Quita las anotaciones `_lee_esto` con que el JSON se explica a sí mismo. */
  function sinNotas<T>(valor: T): T {
    if (Array.isArray(valor)) return valor.map(sinNotas) as unknown as T;
    if (valor !== null && typeof valor === 'object') {
      return Object.fromEntries(
        Object.entries(valor as Record<string, unknown>)
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => [k, sinNotas(v)]),
      ) as T;
    }
    return valor;
  }

  it('REPRODUCEN la carta y el inventario de negocio.ejemplo.json', () => {
    const esperado = sinNotas(
      JSON.parse(leer('negocio.ejemplo.json')) as DescripcionNegocio,
    );

    const r = importar({
      // Se parte del mismo negocio SIN carta ni inventario: es lo que tendría
      // quien va a importarlos desde su Excel.
      negocio: {
        ...esperado,
        carta: [
          {
            marca: esperado.marcas[0]!.nombre,
            gruposModificadores: esperado.carta![0]!.gruposModificadores!,
            productos: [],
          },
        ],
      },
      productosCsv: leer('carta.ejemplo.csv'),
      insumosCsv: leer('insumos.ejemplo.csv'),
      recetasCsv: leer('recetas.ejemplo.csv'),
    });

    expect(r.negocio.carta![0]!.productos).toEqual(
      esperado.carta![0]!.productos,
    );
    expect(r.negocio.carta![0]!.categorias).toEqual(
      esperado.carta![0]!.categorias,
    );
    expect(r.negocio.inventario).toEqual(esperado.inventario);
  });
});
