import {
  encodeCp850,
  CODE_PAGE_CP850,
  fitWidth,
  twoColumns,
} from './encoding.js';

/**
 * Constructor de comandos ESC/POS.
 *
 * ESC/POS es un protocolo de bytes sin verificación: la impresora hace lo que
 * le llega y no responde si algo está mal. Un byte de más deja el ticket
 * cortado a la mitad, y un `init` olvidado hace que el siguiente ticket herede
 * la negrita y el tamaño doble del anterior — el clásico «¿por qué esta
 * comanda salió gigante?».
 *
 * Por eso esto se construye byte a byte y se prueba byte a byte. La única
 * forma de saber que un ticket está bien formado sin tener la impresora
 * delante es comparar la secuencia exacta.
 */

// Comandos crudos. Se nombran para que el que lea el código no tenga que
// tener el manual de Epson abierto al lado.
const ESC = 0x1b;
const GS = 0x1d;

export type Alignment = 'left' | 'center' | 'right';

const ALIGN: Record<Alignment, number> = { left: 0, center: 1, right: 2 };

export interface EscPosOptions {
  /** Caracteres por línea. 32 en las de 58 mm, 48 en las de 80 mm. */
  width?: number;
}

export class EscPosBuilder {
  private readonly chunks: Buffer[] = [];
  readonly width: number;

  constructor(options: EscPosOptions = {}) {
    this.width = options.width ?? 48;
  }

  private push(...bytes: number[]): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  /**
   * Reinicia la impresora y fija la tabla de caracteres.
   *
   * Va SIEMPRE al principio. Sin él, el ticket hereda el estado del anterior:
   * si el previo terminó en negrita y doble alto, este sale igual.
   */
  init(): this {
    this.push(ESC, 0x40); // ESC @
    this.push(ESC, 0x74, CODE_PAGE_CP850); // ESC t n
    return this;
  }

  align(alignment: Alignment): this {
    return this.push(ESC, 0x61, ALIGN[alignment]);
  }

  bold(on: boolean): this {
    return this.push(ESC, 0x45, on ? 1 : 0);
  }

  /**
   * Tamaño en múltiplos (1–8). GS ! codifica ancho en el nibble alto y alto en
   * el bajo, así que `n = (ancho-1) << 4 | (alto-1)`.
   */
  size(width: number, height: number): this {
    const w = Math.min(8, Math.max(1, width)) - 1;
    const h = Math.min(8, Math.max(1, height)) - 1;
    return this.push(GS, 0x21, (w << 4) | h);
  }

  /** Texto tal cual, sin salto de línea. */
  text(value: string): this {
    this.chunks.push(encodeCp850(value));
    return this;
  }

  line(value = ''): this {
    return this.text(`${value}\n`);
  }

  /** Línea con etiqueta a la izquierda e importe a la derecha. */
  columns(left: string, right: string): this {
    return this.line(twoColumns(left, right, this.width));
  }

  /** Separador de ancho completo. */
  separator(char = '-'): this {
    return this.line(char.repeat(this.width));
  }

  /** Texto centrado sin depender del comando de alineación de la impresora. */
  centered(value: string): this {
    const chars = [...value];
    if (chars.length >= this.width)
      return this.line(fitWidth(value, this.width));
    const margen = Math.floor((this.width - chars.length) / 2);
    return this.line(' '.repeat(margen) + value);
  }

  feed(lines = 1): this {
    return this.push(ESC, 0x64, Math.min(255, Math.max(0, lines)));
  }

  /**
   * Corta el papel.
   *
   * Antes del corte se avanzan líneas a propósito: el cabezal está unos
   * milímetros por encima de la cuchilla, y cortar sin avanzar se lleva por
   * delante las últimas líneas del ticket. Es el fallo más común al integrar
   * una térmica por primera vez.
   */
  cut(partial = true): this {
    this.feed(4);
    return this.push(GS, 0x56, partial ? 0x42 : 0x41, 0x00);
  }

  /** Abre el cajón portamonedas (pulso al pin 2). */
  openDrawer(): this {
    return this.push(ESC, 0x70, 0x00, 0x19, 0xfa);
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
