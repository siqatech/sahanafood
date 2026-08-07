import { describe, it, expect } from 'vitest';
import { EscPosBuilder } from './builder.js';

/**
 * ESC/POS no verifica nada: la impresora hace lo que le llega y no responde si
 * está mal. Un byte de más deja el ticket cortado a la mitad. Se compara la
 * secuencia exacta porque es lo único que se puede comprobar sin la impresora
 * delante.
 */

describe('Constructor ESC/POS', () => {
  it('init reinicia la impresora Y fija la tabla de caracteres', () => {
    // Sin el reinicio, el ticket hereda el estado del anterior: si el previo
    // terminó en negrita y doble alto, este sale igual.
    expect([...new EscPosBuilder().init().build()]).toEqual([
      0x1b,
      0x40, // ESC @
      0x1b,
      0x74,
      0x02, // ESC t 2 (CP850)
    ]);
  });

  it('la alineación usa ESC a con su código', () => {
    expect([...new EscPosBuilder().align('center').build()]).toEqual([
      0x1b, 0x61, 0x01,
    ]);
    expect([...new EscPosBuilder().align('right').build()]).toEqual([
      0x1b, 0x61, 0x02,
    ]);
  });

  it('la negrita se enciende y se apaga explícitamente', () => {
    const bytes = [...new EscPosBuilder().bold(true).bold(false).build()];
    expect(bytes).toEqual([0x1b, 0x45, 0x01, 0x1b, 0x45, 0x00]);
  });

  it('el tamaño codifica ancho y alto en un solo byte', () => {
    // GS ! n: ancho en el nibble alto, alto en el bajo.
    expect([...new EscPosBuilder().size(2, 2).build()]).toEqual([
      0x1d, 0x21, 0x11,
    ]);
    expect([...new EscPosBuilder().size(1, 1).build()]).toEqual([
      0x1d, 0x21, 0x00,
    ]);
  });

  it('el tamaño se acota al rango que acepta la impresora', () => {
    // Un valor fuera de rango no da error: imprime basura.
    expect([...new EscPosBuilder().size(99, 0).build()]).toEqual([
      0x1d, 0x21, 0x70,
    ]);
  });

  it('EL CORTE AVANZA PAPEL ANTES de cortar', () => {
    // El cabezal está unos milímetros por encima de la cuchilla: cortar sin
    // avanzar se lleva por delante las últimas líneas del ticket. Es el fallo
    // más común al integrar una térmica por primera vez.
    const bytes = [...new EscPosBuilder().cut().build()];
    expect(bytes).toEqual([
      0x1b,
      0x64,
      0x04, // ESC d 4 — avanza 4 líneas
      0x1d,
      0x56,
      0x42,
      0x00, // GS V B 0 — corte parcial
    ]);
  });

  it('el corte total usa otro modo', () => {
    const bytes = [...new EscPosBuilder().cut(false).build()];
    expect(bytes.slice(3)).toEqual([0x1d, 0x56, 0x41, 0x00]);
  });

  it('abre el cajón con el pulso al pin 2', () => {
    expect([...new EscPosBuilder().openDrawer().build()]).toEqual([
      0x1b, 0x70, 0x00, 0x19, 0xfa,
    ]);
  });

  it('las líneas llevan CRLF', () => {
    const bytes = [...new EscPosBuilder().line('Hola').build()];
    expect(bytes).toEqual([0x48, 0x6f, 0x6c, 0x61, 0x0d, 0x0a]);
  });

  it('centra respetando el ancho configurado', () => {
    const b = new EscPosBuilder({ width: 10 });
    const texto = Buffer.from(b.centered('abcd').build()).toString('latin1');
    expect(texto).toBe('   abcd\r\n');
  });

  it('el separador ocupa el ancho exacto', () => {
    const b = new EscPosBuilder({ width: 12 });
    const texto = Buffer.from(b.separator().build()).toString('latin1');
    expect(texto).toBe('-'.repeat(12) + '\r\n');
  });

  it('un ticket completo es una secuencia bien formada', () => {
    const ticket = new EscPosBuilder({ width: 32 })
      .init()
      .align('center')
      .bold(true)
      .line('SAHANA')
      .bold(false)
      .align('left')
      .separator()
      .columns('Total', 'S/ 38.00')
      .cut()
      .build();

    // Empieza reiniciando y termina cortando: las dos garantías que hacen que
    // el siguiente ticket salga limpio.
    expect([...ticket.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...ticket.subarray(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    expect(ticket.toString('latin1')).toContain('SAHANA');
    expect(ticket.toString('latin1')).toContain('S/ 38.00');
  });
});
