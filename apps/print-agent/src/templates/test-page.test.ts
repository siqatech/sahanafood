import { describe, it, expect } from 'vitest';
import { buildTestPage } from './test-page.js';
import { encodeCp850 } from '../escpos/encoding.js';

/**
 * La página de prueba no dice «OK»: ejercita a propósito todo lo que se rompe
 * en una térmica recién conectada y lo deja visible en el papel. Un «OK» que
 * sale bien impreso no demuestra que «Ración» vaya a salir bien.
 */

const DATOS = {
  printerName: 'cocina',
  target: 'net:192.168.1.50:9100',
  agentVersion: '0.1.0',
  printedAt: '07/08/2026, 20:12:00',
};

/** Lo que la impresora vería, para poder buscar texto en los bytes. */
const comoTexto = (b: Buffer): string => b.toString('latin1');

/**
 * Columnas de papel que ocupa cada línea.
 *
 * Hay que quitar los códigos de control ENTEROS: `ESC a 1` deja una «a»
 * imprimible si solo se filtran los bytes < 0x20, y esa «a» falsea la cuenta.
 */
const columnas = (b: Buffer): string[] =>
  comoTexto(b)
    .split('\r\n')
    .map((l) =>
      l
        // Los caracteres de control en la expresión son justamente el objeto de
        // la búsqueda: ESC (0x1b) y GS (0x1d) abren los comandos ESC/POS.
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b.|\x1d../g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f]/g, ''),
    );

describe('Página de prueba de impresora', () => {
  it('lleva acentos y ñ de verdad, no un «OK»', () => {
    // Es el fallo más común y el que más tarde se descubre: el instalador rara
    // vez imprime algo en español, y luego TODAS las comandas salen «Raci?n».
    const pagina = comoTexto(buildTestPage(DATOS));
    for (const palabra of ['Ración', 'ñandú', 'guarnición', 'Jalapeño']) {
      expect(pagina).toContain(comoTexto(encodeCp850(palabra)));
    }
  });

  it('los acentos van en CP850, no en UTF-8', () => {
    const pagina = buildTestPage(DATOS);
    // «ó» es 0xa2 en CP850. En UTF-8 serían dos bytes (0xc3 0xb3), y la
    // impresora los pintaría como «Ã³».
    expect(pagina).toContain(0xa2);
    expect(comoTexto(pagina)).not.toContain('Ã');
  });

  it('la regla delata el ancho real del papel', () => {
    // Papel de 58 mm configurado como de 80 (o al revés) parte todas las
    // líneas, y no se nota hasta la primera comanda con el local abierto.
    for (const ancho of [32, 48]) {
      // Se extrae la tira de puntos con regex en vez de partir por líneas: la
      // línea anterior deja pegado su ESC E 0, y el byte imprimible de ese
      // código («E») quedaría contado como parte de la regla.
      const texto = comoTexto(buildTestPage(DATOS, { width: ancho }));
      const regla = /\.{9}\d[.\d]*/.exec(texto)?.[0];
      expect(regla).toBeDefined();
      expect(regla!.length).toBe(ancho);
      // Cada decena queda marcada con su número: 10 → «1», 20 → «2».
      expect(regla![9]).toBe('1');
    }
  });

  it('identifica qué impresora es y con qué versión se imprimió', () => {
    // Con dos impresoras iguales encima de la mesa, un papel sin nombre no
    // dice cuál de las dos funcionó. Y soporte pide la versión justo cuando
    // algo va mal.
    const pagina = comoTexto(buildTestPage(DATOS));
    expect(pagina).toContain('cocina');
    expect(pagina).toContain('net:192.168.1.50:9100');
    expect(pagina).toContain('0.1.0');
  });

  it('ejercita tamaños y negrita, que es lo que hace legible una comanda', () => {
    const pagina = buildTestPage(DATOS);
    // `includes` y no `toContain`: sobre un Buffer, `toContain` comprueba
    // bytes sueltos, no la secuencia — pasaría con los bytes desordenados.
    // GS ! con doble ancho y alto (0x11), y ESC E 1 para negrita.
    expect(pagina.includes(Buffer.from([0x1d, 0x21, 0x11]))).toBe(true);
    expect(pagina.includes(Buffer.from([0x1b, 0x45, 0x01]))).toBe(true);
  });

  it('empieza con init y termina cortando', () => {
    // Sin `init` hereda el estado del ticket anterior; sin avance antes del
    // corte, la cuchilla se lleva las últimas líneas.
    const pagina = buildTestPage(DATOS);
    expect(pagina.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(pagina.subarray(-7)).toEqual(
      Buffer.from([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]),
    );
  });

  it('NINGUNA línea se pasa del ancho: si se pasa, la prueba miente', () => {
    // Es la propiedad que hace útil a esta página. Una línea que se desborda la
    // parte la impresora por donde le toca, y entonces ya no se puede
    // distinguir «se partió porque el ancho está mal» —lo que la página existe
    // para detectar— de «se partió porque el texto era largo».
    for (const ancho of [32, 42, 48]) {
      for (const linea of columnas(buildTestPage(DATOS, { width: ancho }))) {
        expect(
          linea.length,
          `«${linea}» ocupa ${linea.length} de ${ancho} columnas`,
        ).toBeLessThanOrEqual(ancho);
      }
    }
  });

  it('una ruta de conexión larguísima se parte, no desborda', () => {
    // En Windows la ruta del dispositivo puede ser interminable, y en Linux un
    // /dev con enlaces también.
    const largo =
      'file:/media/almacenamiento-del-local/dispositivos/impresoras/cocina-principal-planta-baja.bin';
    const pagina = buildTestPage({ ...DATOS, target: largo });
    expect(comoTexto(pagina)).toContain('Conexion');
    for (const linea of columnas(pagina)) {
      expect(linea.length).toBeLessThanOrEqual(48);
    }
  });

  it('dice en el papel cómo interpretarlo', () => {
    // Quien lo sostiene no sabe qué debería ver: la página tiene que decírselo.
    const pagina = comoTexto(buildTestPage(DATOS));
    expect(pagina).toContain('PRUEBA CORRECTA');
    expect(pagina).toContain('sin simbolos raros');
  });
});
