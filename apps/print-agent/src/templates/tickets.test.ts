import { describe, it, expect } from 'vitest';
import { buildKitchenTicket, buildPrecheck } from './tickets.js';
import { encodeCp850 } from '../escpos/encoding.js';

/**
 * Un ticket no se puede «ver» en una prueba: lo que se comprueba es que la
 * secuencia de bytes lleve los comandos que hacen que sea legible en el papel.
 * Cada aserción de aquí corresponde a un fallo real de comanda impresa.
 */

/** Texto plano del ticket, para buscar contenido sin pelearse con los bytes. */
function textoDe(buffer: Buffer): string {
  return buffer.toString('latin1');
}

/** ¿Aparece esta secuencia de comandos en el ticket? */
function contieneBytes(buffer: Buffer, bytes: number[]): boolean {
  return buffer.includes(Buffer.from(bytes));
}

const COMANDA = {
  orderNumber: 1042,
  brandName: 'Sahana Burgers',
  stationName: 'Plancha',
  channel: 'delivery',
  promisedAt: '20:45',
  customerName: 'Rocío Paredes',
  lines: [
    {
      quantity: 2,
      productName: 'Hamburguesa clásica',
      modifiersText: 'sin cebolla, extra queso',
    },
    { quantity: 1, productName: 'Papas', notes: 'crocantes' },
  ],
  notes: 'Tocar el timbre dos veces',
  printedAt: '07/08/2026 20:12',
};

describe('buildKitchenTicket', () => {
  it('abre con init: sin él la comanda hereda negrita y tamaño de la anterior', () => {
    const ticket = buildKitchenTicket(COMANDA);
    // ESC @ debe ser lo PRIMERO, no basta con que aparezca.
    expect(ticket.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
  });

  it('imprime el número de pedido a tamaño doble', () => {
    const ticket = buildKitchenTicket(COMANDA);
    // GS ! 0x11 = ancho x2, alto x2, seguido del número.
    const doble = Buffer.from([0x1d, 0x21, 0x11]);
    const posDoble = ticket.indexOf(doble);
    expect(posDoble).toBeGreaterThanOrEqual(0);
    // El número va inmediatamente después del cambio de tamaño (con la
    // negrita en medio): si va antes, sale en tamaño normal.
    expect(ticket.indexOf(encodeCp850('#1042'))).toBeGreaterThan(posDoble);
  });

  it('no imprime importes: el cocinero no cobra', () => {
    const ticket = textoDe(buildKitchenTicket(COMANDA));
    expect(ticket).not.toContain('S/');
    expect(ticket).not.toContain('TOTAL');
  });

  it('destaca los modificadores en negrita: «sin cebolla» es lo que se pasa por alto', () => {
    const ticket = buildKitchenTicket(COMANDA);
    const negritaOn = ticket.indexOf(Buffer.from([0x1b, 0x45, 0x01]));
    const modificador = ticket.indexOf(encodeCp850('sin cebolla, extra queso'));
    expect(modificador).toBeGreaterThan(negritaOn);
    // Y el texto del modificador va sangrado para no confundirse con un producto.
    expect(textoDe(ticket)).toContain('   > sin cebolla');
  });

  it('lleva estación, canal y hora prometida: es lo que decide el orden de la cocina', () => {
    const ticket = textoDe(buildKitchenTicket(COMANDA));
    expect(ticket).toContain('Plancha');
    expect(ticket).toContain('DELIVERY');
    expect(ticket).toContain('Para: 20:45');
  });

  it('codifica los acentos en CP850, no en UTF-8', () => {
    const ticket = buildKitchenTicket(COMANDA);
    // «clásica» → la á es 0xa0 en CP850, no los dos bytes de UTF-8.
    expect(ticket.includes(encodeCp850('clásica'))).toBe(true);
    expect(ticket.includes(Buffer.from('clásica', 'utf8'))).toBe(false);
  });

  it('omite los bloques opcionales sin dejar líneas vacías con etiqueta', () => {
    const ticket = textoDe(
      buildKitchenTicket({
        orderNumber: 7,
        brandName: 'Sahana',
        stationName: 'Frío',
        channel: 'salon',
        lines: [{ quantity: 1, productName: 'Ensalada' }],
        printedAt: 'x',
      }),
    );
    expect(ticket).not.toContain('Para:');
    expect(ticket).not.toContain('NOTA DEL PEDIDO');
  });

  it('avanza el papel antes de cortar: cortar sin avanzar se lleva las últimas líneas', () => {
    const ticket = buildKitchenTicket(COMANDA);
    const avance = ticket.lastIndexOf(Buffer.from([0x1b, 0x64, 0x04]));
    const corte = ticket.indexOf(Buffer.from([0x1d, 0x56, 0x42, 0x00]));
    expect(avance).toBeGreaterThanOrEqual(0);
    expect(corte).toBeGreaterThan(avance);
  });

  it('respeta el ancho de las impresoras de 58 mm', () => {
    const ticket = textoDe(buildKitchenTicket(COMANDA, { width: 32 }));
    const separadores = ticket
      .split('\r\n')
      .filter((l) => /^[=-]+$/.test(l.trim()) && l.trim().length > 0);
    expect(separadores.length).toBeGreaterThan(0);
    for (const linea of separadores) expect(linea.trim()).toHaveLength(32);
  });
});

const PRECUENTA = {
  orderNumber: 1042,
  brandName: 'Sahana Burgers',
  locationName: 'Miraflores',
  lines: [
    { quantity: 2, productName: 'Hamburguesa clásica', lineTotal: 'S/ 45.80' },
    { quantity: 1, productName: 'Papas', lineTotal: 'S/ 9.90' },
  ],
  subtotal: 'S/ 55.70',
  deliveryFee: 'S/ 6.00',
  total: 'S/ 61.70',
  taxLabel: 'IGV incluido (18%)',
  tax: 'S/ 9.41',
  printedAt: '07/08/2026 20:12',
};

describe('buildPrecheck', () => {
  it('avisa de que NO es comprobante de pago', () => {
    // Un papel con importes, IGV desglosado y el nombre del negocio se parece
    // demasiado a una boleta. Que el cliente se vaya creyendo que la tiene es
    // un problema con SUNAT, no un detalle de diseño.
    const ticket = textoDe(buildPrecheck(PRECUENTA));
    expect(ticket).toContain('NO ES COMPROBANTE DE PAGO');
    expect(ticket).toContain('Solicite su boleta o factura');
  });

  it('alinea los importes a la derecha del ancho del papel', () => {
    const ticket = textoDe(buildPrecheck(PRECUENTA, { width: 48 }));
    const linea = ticket
      .split('\r\n')
      .find((l) => l.includes('Papas') && l.includes('S/ 9.90'));
    expect(linea).toBeDefined();
    expect(linea).toHaveLength(48);
    expect(linea!.endsWith('S/ 9.90')).toBe(true);
  });

  it('nunca recorta el importe, aunque el nombre del producto sea larguísimo', () => {
    const ticket = textoDe(
      buildPrecheck(
        {
          ...PRECUENTA,
          lines: [
            {
              quantity: 1,
              productName:
                'Hamburguesa doble con queso cheddar, tocino y salsa de la casa en pan brioche',
              lineTotal: 'S/ 45.80',
            },
          ],
        },
        { width: 32 },
      ),
    );
    const linea = ticket.split('\r\n').find((l) => l.includes('S/ 45.80'));
    expect(linea).toHaveLength(32);
    expect(linea!.endsWith('S/ 45.80')).toBe(true);
  });

  it('pone el IGV DESPUÉS del total: está incluido, no se suma (RN-T05)', () => {
    const ticket = textoDe(buildPrecheck(PRECUENTA));
    expect(ticket.indexOf('IGV incluido')).toBeGreaterThan(
      ticket.indexOf('TOTAL'),
    );
  });

  it('omite descuento y propina cuando no los hay', () => {
    const ticket = textoDe(buildPrecheck(PRECUENTA));
    expect(ticket).not.toContain('Descuento');
    expect(ticket).not.toContain('Propina');
    expect(ticket).toContain('Delivery');
  });

  it('imprime el total a doble alto', () => {
    const ticket = buildPrecheck(PRECUENTA);
    const dobleAlto = ticket.indexOf(Buffer.from([0x1d, 0x21, 0x01]));
    expect(dobleAlto).toBeGreaterThanOrEqual(0);
    expect(ticket.indexOf(encodeCp850('TOTAL'))).toBeGreaterThan(dobleAlto);
  });

  it('abre con init y termina cortando', () => {
    const ticket = buildPrecheck(PRECUENTA);
    expect(ticket.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    expect(contieneBytes(ticket, [0x1d, 0x56, 0x42, 0x00])).toBe(true);
  });
});
