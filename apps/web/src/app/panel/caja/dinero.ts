import type { Importe } from '../../../lib/panel-api';

/**
 * Importe a texto SIN pasar por coma flotante.
 *
 * `minorUnits / 10 ** scale` es la forma obvia y es la prohibida por CLAUDE.md.
 * Aquí se corta la cadena de dígitos: exacto para cualquier magnitud, y sin una
 * sola división. Vive en su propio archivo porque lo usan tres pantallas y una
 * tercera copia habría acabado siendo la que se desvía.
 */
export function soles(total: Importe): string {
  const negativo = total.minorUnits < 0;
  const digitos = String(Math.abs(total.minorUnits)).padStart(
    total.scale + 1,
    '0',
  );
  const corte = digitos.length - total.scale;
  // Dos decimales aunque se guarden cuatro: el resto solo aparece en cálculos
  // intermedios y nadie lee un arqueo con cuatro decimales.
  const decimales = digitos.slice(corte, corte + 2).padEnd(2, '0');
  return `${negativo ? '-' : ''}${digitos.slice(0, corte)}.${decimales}`;
}

/**
 * Lo mismo para un importe que llega como DECIMAL de la base.
 *
 * `NUMERIC(14,4)` viaja como texto —«32.0000»— porque pasarlo por `Number`
 * antes de enseñarlo lo metería en coma flotante justo delante de alguien que
 * lo va a declarar. Aquí solo se recorta la cadena: dos decimales, que es como
 * se lee el dinero, sin tocar el valor.
 */
export function solesDeTexto(valor: string): string {
  const [entero = '0', decimales = ''] = valor.split('.');
  return `${entero}.${decimales.slice(0, 2).padEnd(2, '0')}`;
}

/** ¿La diferencia del arqueo es distinta de cero? */
export function hayDiferencia(diferencia: Importe | null): boolean {
  return diferencia !== null && diferencia.minorUnits !== 0;
}
