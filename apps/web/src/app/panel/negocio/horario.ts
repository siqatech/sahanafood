/**
 * El horario semanal, tal como se escribe en una pantalla (RN-ORG-03).
 *
 * Va aparte de la página porque es la única parte con reglas, y las reglas
 * importan: un horario mal guardado hace que la tienda acepte pedidos con el
 * local cerrado —comida que nadie va a cocinar— o que los rechace con la cocina
 * llena. Las dos se descubren tarde y por el lado del cliente.
 *
 * Lo que NO se hace aquí es evaluar el horario: eso es de `isOpenAt`, en
 * `@sahana/domain`, que es el mismo código que usan la tienda, el agente y el
 * POS sin conexión. Aquí solo se lee lo que se tecleó.
 */

export const DIAS = [
  { indice: 0, nombre: 'Domingo' },
  { indice: 1, nombre: 'Lunes' },
  { indice: 2, nombre: 'Martes' },
  { indice: 3, nombre: 'Miércoles' },
  { indice: 4, nombre: 'Jueves' },
  { indice: 5, nombre: 'Viernes' },
  { indice: 6, nombre: 'Sábado' },
] as const;

export interface FranjaSemanal {
  weekday: number;
  opensAt: string;
  closesAt: string;
}

export type SemanaRevisada = { weekly: FranjaSemanal[] } | { error: string };

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Lee los siete días del formulario.
 *
 * Un día con los dos campos vacíos está CERRADO, y eso no es un error: hay
 * locales que cierran los lunes. Un día con uno solo relleno sí lo es —«abre a
 * las 12» sin cierre no se puede evaluar— y se dice con el nombre del día,
 * porque «campo inválido» en una rejilla de catorce casillas no ayuda.
 *
 * Cruzar la medianoche está PERMITIDO: `18:00–02:00` es lo normal en una
 * pollería, y el dominio lo entiende. Por eso no se comprueba que el cierre sea
 * posterior a la apertura.
 */
export function revisarSemana(
  leer: (campo: string) => string | null,
): SemanaRevisada {
  const weekly: FranjaSemanal[] = [];

  for (const dia of DIAS) {
    const abre = (leer(`abre-${dia.indice}`) ?? '').trim();
    const cierra = (leer(`cierra-${dia.indice}`) ?? '').trim();

    if (abre === '' && cierra === '') continue;
    if (abre === '' || cierra === '') {
      return {
        error: `El ${dia.nombre.toLowerCase()} tiene solo una hora. Pon las dos, o déjalo vacío para cerrar ese día.`,
      };
    }
    if (!HORA.test(abre) || !HORA.test(cierra)) {
      return {
        error: `La hora del ${dia.nombre.toLowerCase()} no vale. Escríbela como 12:00.`,
      };
    }
    if (abre === cierra) {
      // Abrir y cerrar a la misma hora no dice si son cero horas o
      // veinticuatro, y las dos lecturas son defendibles. No se adivina.
      return {
        error: `El ${dia.nombre.toLowerCase()} abre y cierra a la misma hora. Si abre todo el día, pon 00:00 y 23:59.`,
      };
    }
    weekly.push({ weekday: dia.indice, opensAt: abre, closesAt: cierra });
  }

  return { weekly };
}

/** ¿El horario deja abierto algún día? Un local cerrado la semana entera no vende. */
export function cierraSiempre(weekly: readonly FranjaSemanal[]): boolean {
  return weekly.length === 0;
}

export interface Feriado {
  date: string;
  ranges: Array<{ opensAt: string; closesAt: string }>;
}

/**
 * Un feriado: la fecha y, si abre con horario especial, las horas.
 *
 * Sin horas es **cerrado todo el día**, que es el caso normal —28 de julio— y
 * por eso es el que no pide nada. Una excepción REEMPLAZA al horario semanal de
 * esa fecha, no se le suma: es lo que decide `@sahana/domain`, y decirlo aquí
 * evita que alguien espere que se acumulen.
 */
export function revisarFeriado(
  fecha: unknown,
  abre: unknown,
  cierra: unknown,
): { feriado: Feriado } | { error: string } {
  const dia = String(fecha ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
    return { error: 'Elige la fecha del feriado.' };
  }

  const a = String(abre ?? '').trim();
  const c = String(cierra ?? '').trim();
  if (a === '' && c === '') return { feriado: { date: dia, ranges: [] } };
  if (a === '' || c === '') {
    return {
      error:
        'Pon las dos horas si ese día abre con horario especial, o ninguna si cierra.',
    };
  }
  if (!HORA.test(a) || !HORA.test(c)) {
    return { error: 'La hora no vale. Escríbela como 12:00.' };
  }
  return { feriado: { date: dia, ranges: [{ opensAt: a, closesAt: c }] } };
}
