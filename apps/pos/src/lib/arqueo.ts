import { Money } from '@sahana/domain';

/**
 * Conteo de la gaveta por denominación (ux/01, «Cierre de caja»).
 *
 * Se cuenta **por billete y por moneda**, no escribiendo un total. Es la
 * diferencia entre un arqueo y una adivinanza: quien escribe «1 250» al final
 * del turno escribe lo que espera encontrar, y el descuadre aparece semanas
 * después sin que nadie sepa de qué día viene.
 *
 * El desglose se queda en el dispositivo: la API recibe el total declarado y es
 * lo correcto —el arqueo es «cuánto hay», no «en qué billetes»—. Lo que sí se
 * imprime en el resumen del turno es el desglose, porque es lo que permite
 * recontar sin volver a empezar.
 */

/** Denominaciones del sol, de mayor a menor. En unidades menores (escala 4). */
export const DENOMINACIONES = [
  { minor: 2_000_000, rotulo: 'S/ 200', tipo: 'billete' },
  { minor: 1_000_000, rotulo: 'S/ 100', tipo: 'billete' },
  { minor: 500_000, rotulo: 'S/ 50', tipo: 'billete' },
  { minor: 200_000, rotulo: 'S/ 20', tipo: 'billete' },
  { minor: 100_000, rotulo: 'S/ 10', tipo: 'billete' },
  { minor: 50_000, rotulo: 'S/ 5', tipo: 'moneda' },
  { minor: 20_000, rotulo: 'S/ 2', tipo: 'moneda' },
  { minor: 10_000, rotulo: 'S/ 1', tipo: 'moneda' },
  { minor: 5_000, rotulo: '50 cts', tipo: 'moneda' },
  { minor: 2_000, rotulo: '20 cts', tipo: 'moneda' },
  { minor: 1_000, rotulo: '10 cts', tipo: 'moneda' },
] as const;

export type Conteo = Record<number, number>;

/**
 * Total contado. Con `Money` y multiplicación entera: son cuatro billetes de
 * 200 y ese producto no puede pasar por coma flotante.
 */
export function totalContado(conteo: Conteo): Money {
  return DENOMINACIONES.reduce((acc, d) => {
    const cuantos = conteo[d.minor] ?? 0;
    if (cuantos <= 0) return acc;
    return acc.add(Money.fromMinor(d.minor).multiplyByQuantity(cuantos));
  }, Money.fromMinor(0));
}

/**
 * Diferencia contra lo esperado. Positiva = sobra, negativa = falta.
 *
 * Se calcula en vivo mientras se cuenta, que es lo que hace que quien cuenta
 * vuelva a contar en el momento y no al día siguiente.
 */
export function diferencia(contado: Money, esperado: Money): Money {
  return contado.subtract(esperado);
}

/**
 * ¿Se puede cerrar sin firmar?
 *
 * Solo con diferencia exactamente cero. Cualquier descuadre exige motivo y PIN
 * de supervisor (RN-POS-02): un cierre descuadrado sin firmar es la forma más
 * limpia de que el dinero desaparezca sin que quede nadie señalado.
 */
export function exigeAprobacion(dif: Money): boolean {
  return dif.minorUnits !== 0;
}

/** Desglose legible para el resumen impreso del turno. */
export function lineasDelConteo(
  conteo: Conteo,
): Array<{ rotulo: string; cuantos: number; subtotal: Money }> {
  return DENOMINACIONES.filter((d) => (conteo[d.minor] ?? 0) > 0).map((d) => ({
    rotulo: d.rotulo,
    cuantos: conteo[d.minor] ?? 0,
    subtotal: Money.fromMinor(d.minor).multiplyByQuantity(conteo[d.minor] ?? 0),
  }));
}
