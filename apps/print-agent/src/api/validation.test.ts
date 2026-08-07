import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseComanda,
  parsePrecuenta,
  parsePrueba,
  DatosInvalidosError,
} from './validation.js';

const COMANDA = {
  printer: 'cocina',
  orderNumber: 1042,
  brandName: 'Sahana Burgers',
  stationName: 'Plancha',
  channel: 'delivery',
  lines: [{ quantity: 2, productName: 'Hamburguesa clásica' }],
};

const PRECUENTA = {
  printer: 'cocina',
  orderNumber: 1042,
  brandName: 'Sahana Burgers',
  locationName: 'Miraflores',
  lines: [{ quantity: 1, productName: 'Gaseosa', lineTotal: 'S/ 5.00' }],
  subtotal: 'S/ 5.00',
  total: 'S/ 5.00',
  taxLabel: 'IGV incluido (18%)',
  tax: 'S/ 0.76',
};

const fallos = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DatosInvalidosError) return e.issues;
    throw e;
  }
  throw new Error('Se esperaba un error de validación y no lo hubo.');
};

describe('Validación de peticiones', () => {
  it('acepta una comanda completa', () => {
    expect(parseComanda(COMANDA).orderNumber).toBe(1042);
    expect(parsePrecuenta(PRECUENTA).total).toBe('S/ 5.00');
    expect(parsePrueba({ printer: 'cocina' }).printer).toBe('cocina');
  });

  it('acumula TODOS los fallos, no solo el primero', () => {
    // Quien integra la PWA quiere ver los cinco campos que le faltan de una
    // vez, no descubrirlos en cinco intentos.
    const issues = fallos(() => parseComanda({}));
    expect(issues.length).toBeGreaterThan(4);
    expect(issues.join(' ')).toContain('printer');
    expect(issues.join(' ')).toContain('orderNumber');
    expect(issues.join(' ')).toContain('lines');
  });

  it('dice QUÉ línea falla, no solo que alguna falla', () => {
    // Con doce líneas en el ticket, «quantity inválido» no sirve de nada.
    const issues = fallos(() =>
      parseComanda({
        ...COMANDA,
        lines: [
          { quantity: 1, productName: 'Bien' },
          { quantity: 0, productName: 'Mal' },
        ],
      }),
    );
    expect(issues).toEqual([
      'lines[1]."quantity" debe ser un entero mayor que cero',
    ]);
  });

  it('rechaza una lista de líneas vacía: la cocina no sabría qué preparar', () => {
    expect(fallos(() => parseComanda({ ...COMANDA, lines: [] }))[0]).toContain(
      'al menos un elemento',
    );
  });

  it('rechaza cantidades que no son enteros positivos', () => {
    for (const mala of [0, -1, 2.5, '2', null]) {
      expect(() =>
        parseComanda({
          ...COMANDA,
          lines: [{ quantity: mala, productName: 'X' }],
        }),
      ).toThrow(DatosInvalidosError);
    }
  });

  it('los importes son TEXTO ya formateado, nunca números', () => {
    // El cálculo vive en @sahana/domain. Aceptar un number aquí invitaría a
    // formatearlo en el agente y a que la precuenta no cuadre con la boleta.
    const issues = fallos(() =>
      parsePrecuenta({
        ...PRECUENTA,
        lines: [{ quantity: 1, productName: 'Gaseosa', lineTotal: 5 }],
        total: 5,
      }),
    );
    expect(issues.join(' ')).toContain('lineTotal');
    expect(issues.join(' ')).toContain('total');
  });

  it('los campos opcionales pueden faltar, pero no venir vacíos', () => {
    expect(
      parseComanda({ ...COMANDA, notes: undefined }).notes,
    ).toBeUndefined();
    // Una cadena vacía suele ser un bug de quien llama, no una intención.
    expect(() => parseComanda({ ...COMANDA, notes: '' })).toThrow(
      DatosInvalidosError,
    );
  });

  it('un cuerpo que no es un objeto no revienta: se valida igual', () => {
    for (const basura of [null, 42, 'texto', []]) {
      expect(() => parseComanda(basura)).toThrow(DatosInvalidosError);
    }
  });
});

describe('El agente no tiene dependencias de ejecución', () => {
  /**
   * Es la propiedad que hace que el instalador sea una copia de carpeta.
   *
   * Con una sola dependencia deja de serlo: `node_modules` en un monorepo pnpm
   * son enlaces al almacén, así que haría falta un bundler, o bajar paquetes
   * de npm en el local, o distribuir un tarball aplanado. Las tres añaden una
   * pieza que puede fallar donde menos podemos ir a arreglarla.
   */
  const raiz = fileURLToPath(new URL('../..', import.meta.url));

  it('package.json no declara ninguna dependencia', () => {
    const pkg = JSON.parse(
      readFileSync(join(raiz, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('ningún fichero importa nada que no sea de Node o del propio agente', () => {
    const ficheros: string[] = [];
    const recorrer = (dir: string): void => {
      for (const entrada of readdirSync(dir)) {
        const ruta = join(dir, entrada);
        if (statSync(ruta).isDirectory()) recorrer(ruta);
        else if (entrada.endsWith('.ts') && !entrada.endsWith('.test.ts')) {
          ficheros.push(ruta);
        }
      }
    };
    recorrer(join(raiz, 'src'));
    expect(ficheros.length).toBeGreaterThan(5);

    const externos: string[] = [];
    for (const fichero of ficheros) {
      const codigo = readFileSync(fichero, 'utf8');
      for (const m of codigo.matchAll(/from\s+'([^']+)'/g)) {
        const modulo = m[1]!;
        const propio = modulo.startsWith('.') || modulo.startsWith('node:');
        if (!propio) externos.push(`${fichero}: ${modulo}`);
      }
    }
    expect(externos).toEqual([]);
  });
});
