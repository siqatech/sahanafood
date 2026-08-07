/**
 * Quantity — value object de cantidad de insumo.
 *
 * Existe por el mismo motivo que `Money`, y no es una exageración: una receta
 * dice «0.150 kg de carne», el pedido lleva 3 hamburguesas y la merma de corte
 * es del 5 %. Con `number` decimal, `0.15 * 3 * 1.05` no da lo que da a mano, y
 * el error se acumula movimiento a movimiento en un kardex que es append-only.
 * Al cabo de un día de servicio, el stock materializado y la suma del kardex
 * dejan de cuadrar — y la prueba de consistencia de la spec 08 los compara.
 *
 * Representación interna: entero a escala 4, igual que `Money` y que el
 * `NUMERIC(14,4)` de la base. Así el redondeo ocurre en un solo sitio y de una
 * sola forma.
 *
 * La **unidad va dentro del valor** a propósito. Sumar gramos con mililitros es
 * el error que produce una lista de compra imposible, y en una receta de cocina
 * conviven los dos todo el rato. Aquí no compila... y si viene de la base,
 * lanza.
 */

/** Escala interna: 4 decimales. Coincide con NUMERIC(14,4). */
export const QUANTITY_SCALE = 4;
const QUANTITY_FACTOR = 10 ** QUANTITY_SCALE;

/**
 * Unidades base del MVP. Cada insumo se guarda SIEMPRE en su unidad base:
 * la conversión kg→g o L→ml se hace al capturar, nunca al consumir. Convertir
 * en cada movimiento multiplica las ocasiones de equivocarse por el número de
 * movimientos.
 */
export const UNITS = ['g', 'ml', 'unit'] as const;
export type Unit = (typeof UNITS)[number];

export class QuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuantityError';
  }
}

/** División entera con redondeo half-up, igual que en Money. */
function divRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) {
    throw new QuantityError('División por cero en cálculo de cantidad.');
  }
  const negativo = numerator < 0 !== denominator < 0;
  const a = Math.abs(numerator);
  const b = Math.abs(denominator);
  const q = Math.floor(a / b);
  const r = a - q * b;
  const redondeado = r * 2 >= b ? q + 1 : q;
  return negativo ? -redondeado : redondeado;
}

function assertSafeInteger(value: number, contexto: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new QuantityError(
      `Desbordamiento de cantidad en ${contexto}: el resultado excede el entero seguro.`,
    );
  }
}

export class Quantity {
  /** Unidades menores enteras a escala 4. */
  readonly minorUnits: number;
  readonly unit: Unit;

  private constructor(minorUnits: number, unit: Unit) {
    if (!Number.isInteger(minorUnits)) {
      throw new QuantityError('minorUnits debe ser un entero.');
    }
    assertSafeInteger(minorUnits, 'constructor');
    if (!UNITS.includes(unit)) {
      throw new QuantityError(`Unidad desconocida: ${String(unit)}.`);
    }
    this.minorUnits = minorUnits;
    this.unit = unit;
    Object.freeze(this);
  }

  static fromMinorUnits(minorUnits: number, unit: Unit): Quantity {
    return new Quantity(minorUnits, unit);
  }

  /** Desde un número decimal (`0.15`). Solo en los bordes: captura y lectura de BD. */
  static fromDecimal(value: number, unit: Unit): Quantity {
    if (!Number.isFinite(value)) {
      throw new QuantityError(`Cantidad no finita: ${value}.`);
    }
    // Se redondea al construir: es el único punto donde entra un decimal, y
    // dejar pasar un valor con más de 4 decimales lo perdería en silencio.
    return new Quantity(Math.round(value * QUANTITY_FACTOR), unit);
  }

  /** Desde la cadena que devuelve PostgreSQL para NUMERIC ("0.1500"). */
  static fromDatabase(value: string, unit: Unit): Quantity {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new QuantityError(
        `Cantidad inválida leída de la base: "${value}".`,
      );
    }
    return Quantity.fromDecimal(n, unit);
  }

  static zero(unit: Unit): Quantity {
    return new Quantity(0, unit);
  }

  private assertSameUnit(otra: Quantity): void {
    if (this.unit !== otra.unit) {
      // Sumar gramos con mililitros produce una lista de compra imposible y
      // un food cost que nadie sabe explicar.
      throw new QuantityError(
        `Operación entre unidades distintas: ${this.unit} vs ${otra.unit}.`,
      );
    }
  }

  add(otra: Quantity): Quantity {
    this.assertSameUnit(otra);
    const suma = this.minorUnits + otra.minorUnits;
    assertSafeInteger(suma, 'add');
    return new Quantity(suma, this.unit);
  }

  subtract(otra: Quantity): Quantity {
    this.assertSameUnit(otra);
    const resta = this.minorUnits - otra.minorUnits;
    assertSafeInteger(resta, 'subtract');
    return new Quantity(resta, this.unit);
  }

  /** Multiplica por un entero (las unidades pedidas). */
  multiply(factor: number): Quantity {
    if (!Number.isInteger(factor)) {
      throw new QuantityError(
        `multiply() espera un entero; para porcentajes usa applyBps(). Recibido: ${factor}.`,
      );
    }
    const producto = this.minorUnits * factor;
    assertSafeInteger(producto, 'multiply');
    return new Quantity(producto, this.unit);
  }

  /**
   * Aplica un factor en puntos básicos: `applyBps(10_000)` deja igual,
   * `applyBps(10_500)` añade un 5 %.
   *
   * En bps y no en decimal porque una merma del 5 % escrita como `1.05`
   * arrastra el error de coma flotante que este value object existe para
   * evitar. El redondeo es half-up, el mismo de Money: dos redondeos
   * distintos en el mismo sistema son dos formas de descuadrar.
   */
  applyBps(bps: number): Quantity {
    if (!Number.isInteger(bps) || bps < 0) {
      throw new QuantityError(
        `Los puntos básicos deben ser un entero no negativo. Recibido: ${bps}.`,
      );
    }
    const producto = this.minorUnits * bps;
    assertSafeInteger(producto, 'applyBps');
    return new Quantity(divRoundHalfUp(producto, 10_000), this.unit);
  }

  negate(): Quantity {
    return new Quantity(-this.minorUnits, this.unit);
  }

  isZero(): boolean {
    return this.minorUnits === 0;
  }

  isNegative(): boolean {
    return this.minorUnits < 0;
  }

  equals(otra: Quantity): boolean {
    return this.unit === otra.unit && this.minorUnits === otra.minorUnits;
  }

  compare(otra: Quantity): number {
    this.assertSameUnit(otra);
    return this.minorUnits - otra.minorUnits;
  }

  toDecimal(): number {
    return this.minorUnits / QUANTITY_FACTOR;
  }

  /** Cadena para NUMERIC(14,4). Sin coma flotante por el camino. */
  toDatabase(): string {
    const negativo = this.minorUnits < 0;
    const abs = Math.abs(this.minorUnits);
    const entera = Math.floor(abs / QUANTITY_FACTOR);
    const decimal = String(abs % QUANTITY_FACTOR).padStart(QUANTITY_SCALE, '0');
    return `${negativo ? '-' : ''}${entera}.${decimal}`;
  }

  toString(): string {
    return `${this.toDatabase()} ${this.unit}`;
  }
}

/** Suma una lista, exigiendo unidad común. Lista vacía → cero en `unit`. */
export function sumQuantities(
  cantidades: readonly Quantity[],
  unit: Unit,
): Quantity {
  return cantidades.reduce<Quantity>(
    (acc, q) => acc.add(q),
    Quantity.zero(unit),
  );
}
