/**
 * Money — value object de dinero para Sahana Food.
 *
 * Reglas (docs/04-business-rules.md, ADR-0006):
 *  - RN-T04: todo monto se calcula aquí. Redondeo half-up (ties away from zero,
 *    equivalente a Java BigDecimal.ROUND_HALF_UP) a 2 decimales SOLO al total;
 *    los subtotales conservan 4 decimales.
 *  - RN-T05: IGV 18% incluido en el precio; el desglose se calcula hacia atrás.
 *
 * Representación interna: entero de "unidades menores" a escala 4
 * (diezmilésimos), coherente con `NUMERIC(14,4)` en PostgreSQL. Nunca usamos
 * `number` decimal para operar: JavaScript no tiene decimales exactos y sumar
 * con punto flotante produce descuadres de caja reales. Este es el riesgo #1
 * del stack (ADR-0006) y por eso Money es la ÚNICA vía permitida.
 *
 * `toCents()` / `roundToCents()` entregan la representación a 2 decimales que
 * exige el comprobante electrónico de SUNAT.
 */

/** Escala interna: 4 decimales (diezmilésimos). Coincide con NUMERIC(14,4). */
export const MINOR_SCALE = 4;
const MINOR_FACTOR = 10 ** MINOR_SCALE; // 10000

/** Código de moneda ISO-4217 soportado en el MVP. */
export type CurrencyCode = 'PEN' | 'USD';

const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = ['PEN', 'USD'];

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * División entera con redondeo half-up (ties away from zero).
 * Mantiene el signo del resultado matemático.
 */
function divRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) {
    throw new MoneyError('División por cero en cálculo monetario.');
  }
  const negative = numerator < 0 !== denominator < 0;
  const a = Math.abs(numerator);
  const b = Math.abs(denominator);
  const q = Math.floor(a / b);
  const r = a - q * b;
  // Empate (r*2 === b) redondea hacia arriba en magnitud (away from zero).
  const rounded = r * 2 >= b ? q + 1 : q;
  return negative ? -rounded : rounded;
}

function assertSafeInteger(value: number, context: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(
      `Desbordamiento monetario en ${context}: el resultado excede el entero seguro.`,
    );
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Operación entre monedas distintas: ${a.currency} vs ${b.currency}.`,
    );
  }
}

export class Money {
  /** Unidades menores enteras a escala 4 (diezmilésimos). */
  readonly minorUnits: number;
  readonly currency: CurrencyCode;

  private constructor(minorUnits: number, currency: CurrencyCode) {
    if (!Number.isInteger(minorUnits)) {
      throw new MoneyError('minorUnits debe ser un entero.');
    }
    assertSafeInteger(minorUnits, 'constructor');
    this.minorUnits = minorUnits;
    this.currency = currency;
    Object.freeze(this);
  }

  // ---------------------------------------------------------------- Fábricas

  /** Construye desde unidades menores enteras (escala 4). Vía canónica. */
  static fromMinor(minorUnits: number, currency: CurrencyCode = 'PEN'): Money {
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      throw new MoneyError(`Moneda no soportada: ${currency}.`);
    }
    return new Money(minorUnits, currency);
  }

  /**
   * Construye desde una cadena decimal exacta, p. ej. "12.50" o "-3.1234".
   * Se evita `number` para no arrastrar error de punto flotante.
   * Máximo 4 decimales; más decimales es un error explícito.
   */
  static parse(amount: string, currency: CurrencyCode = 'PEN'): Money {
    const trimmed = amount.trim();
    const match = /^(-)?(\d+)(?:\.(\d{1,4}))?$/.exec(trimmed);
    if (!match) {
      throw new MoneyError(
        `Monto inválido: "${amount}". Formato esperado: entero con hasta 4 decimales.`,
      );
    }
    // Grupos: 1=signo (opcional), 2=parte entera (obligatoria), 3=decimales (opcional).
    const [, negativeSign, whole, frac = ''] = match;
    const sign = negativeSign ? -1 : 1;
    const fracPadded = frac.padEnd(MINOR_SCALE, '0');
    const minor = sign * (Number(whole) * MINOR_FACTOR + Number(fracPadded));
    return Money.fromMinor(minor, currency);
  }

  /** Cero en la moneda dada. */
  static zero(currency: CurrencyCode = 'PEN'): Money {
    return Money.fromMinor(0, currency);
  }

  // ------------------------------------------------------------- Aritmética

  add(other: Money): Money {
    assertSameCurrency(this, other);
    const sum = this.minorUnits + other.minorUnits;
    assertSafeInteger(sum, 'add');
    return new Money(sum, this.currency);
  }

  subtract(other: Money): Money {
    assertSameCurrency(this, other);
    const diff = this.minorUnits - other.minorUnits;
    assertSafeInteger(diff, 'subtract');
    return new Money(diff, this.currency);
  }

  /** Multiplica por una cantidad entera (unidades de un producto). */
  multiplyByQuantity(quantity: number): Money {
    if (!Number.isInteger(quantity)) {
      throw new MoneyError('La cantidad debe ser un entero.');
    }
    const product = this.minorUnits * quantity;
    assertSafeInteger(product, 'multiplyByQuantity');
    return new Money(product, this.currency);
  }

  /**
   * Multiplica por un factor racional (numerador/denominador en enteros),
   * p. ej. un porcentaje: `multiplyByRatio(15, 100)` para 15 %.
   * Redondea half-up a la escala interna (4 decimales). Se usa para
   * descuentos/impuestos; el redondeo final a 2 decimales ocurre en el total.
   */
  multiplyByRatio(numerator: number, denominator: number): Money {
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
      throw new MoneyError('El ratio debe expresarse con enteros.');
    }
    const scaled = this.minorUnits * numerator;
    assertSafeInteger(scaled, 'multiplyByRatio');
    return new Money(divRoundHalfUp(scaled, denominator), this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  abs(): Money {
    return this.minorUnits < 0 ? this.negate() : this;
  }

  // -------------------------------------------------------------- Redondeo

  /**
   * Redondea half-up a `decimals` decimales (por defecto 2). Devuelve un Money
   * cuya representación interna sigue a escala 4 pero con los dígitos por debajo
   * de `decimals` en cero. RN-T04: se aplica al TOTAL, no a los subtotales.
   */
  roundTo(decimals = 2): Money {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MINOR_SCALE) {
      throw new MoneyError(
        `Decimales fuera de rango: ${decimals} (0..${MINOR_SCALE}).`,
      );
    }
    const step = 10 ** (MINOR_SCALE - decimals);
    if (step === 1) {
      return this;
    }
    const rounded = divRoundHalfUp(this.minorUnits, step) * step;
    return new Money(rounded, this.currency);
  }

  /** Atajo: redondea a céntimos (2 decimales) para el comprobante SUNAT. */
  roundToCents(): Money {
    return this.roundTo(2);
  }

  // ------------------------------------------------------------ Reparto

  /**
   * Reparte el monto en `parts` porciones lo más iguales posible sin perder ni
   * inventar céntimos (la suma de las porciones === total). Los restos se
   * distribuyen uno a uno desde la primera porción. Útil para prorratear
   * descuentos o comisiones entre líneas.
   */
  allocate(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new MoneyError(
        'El número de porciones debe ser un entero positivo.',
      );
    }
    const base = Math.trunc(this.minorUnits / parts);
    let remainder = this.minorUnits - base * parts;
    const step = remainder >= 0 ? 1 : -1;
    remainder = Math.abs(remainder);
    const result: Money[] = [];
    for (let i = 0; i < parts; i++) {
      const extra = remainder > 0 ? step : 0;
      if (remainder > 0) remainder--;
      result.push(new Money(base + extra, this.currency));
    }
    return result;
  }

  // ------------------------------------------------------------ Comparación

  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  compareTo(other: Money): -1 | 0 | 1 {
    assertSameCurrency(this, other);
    if (this.minorUnits < other.minorUnits) return -1;
    if (this.minorUnits > other.minorUnits) return 1;
    return 0;
  }

  greaterThan(other: Money): boolean {
    return this.compareTo(other) === 1;
  }

  lessThan(other: Money): boolean {
    return this.compareTo(other) === -1;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compareTo(other) >= 0;
  }

  isZero(): boolean {
    return this.minorUnits === 0;
  }

  isNegative(): boolean {
    return this.minorUnits < 0;
  }

  isPositive(): boolean {
    return this.minorUnits > 0;
  }

  // ------------------------------------------------------------ Serialización

  /** Entero de céntimos (2 decimales) tras redondear half-up. Para SUNAT/DTO. */
  toCents(): number {
    return divRoundHalfUp(this.minorUnits, 100);
  }

  /** Cadena decimal exacta a 4 decimales, p. ej. "12.5000". Para NUMERIC(14,4). */
  toDecimalString(): string {
    const negative = this.minorUnits < 0;
    const abs = Math.abs(this.minorUnits);
    const whole = Math.trunc(abs / MINOR_FACTOR);
    const frac = String(abs % MINOR_FACTOR).padStart(MINOR_SCALE, '0');
    return `${negative ? '-' : ''}${whole}.${frac}`;
  }

  /** Objeto plano para DTOs de API/eventos: céntimos enteros + moneda. */
  toJSON(): { minorUnits: number; currency: CurrencyCode; scale: number } {
    return {
      minorUnits: this.minorUnits,
      currency: this.currency,
      scale: MINOR_SCALE,
    };
  }

  toString(): string {
    return `${this.currency} ${this.toDecimalString()}`;
  }
}

/** Suma una lista de Money de la misma moneda. Lista vacía → error (moneda ambigua). */
export function sumMoney(values: readonly Money[]): Money {
  if (values.length === 0) {
    throw new MoneyError(
      'No se puede sumar una lista vacía (moneda ambigua). Usa Money.zero(moneda).',
    );
  }
  return values.reduce((acc, m) => acc.add(m));
}
