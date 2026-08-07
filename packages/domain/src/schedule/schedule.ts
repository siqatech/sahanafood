/**
 * Horarios de atención (RN-ORG-03): por (marca, local, canal), con excepciones
 * por fecha (feriados) y **turnos que cruzan medianoche**.
 *
 * Vive en el dominio compartido por el mismo motivo que la cobertura: la
 * tienda, el agente de IA, el POS y el servidor tienen que coincidir en si el
 * local está abierto. Que la tienda acepte un pedido a las 23:50 y el servidor
 * lo rechace es un pedido perdido y una queja.
 *
 * Las horas se expresan como "HH:MM" en la **zona horaria del local**. La
 * conversión desde UTC ocurre en el borde (docs/29: timestamptz en BD, ISO-8601
 * UTC en API, formateo a zona del local solo en frontend/print); aquí se opera
 * con la hora local ya resuelta, que es como razona el operador del negocio.
 */

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/** 0 = domingo … 6 = sábado (igual que `Date.getDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Franja de atención de un día.
 * Si `closesAt <= opensAt`, la franja **cruza la medianoche** y termina al día
 * siguiente (p. ej. 20:00 → 02:00). Es el caso normal en delivery nocturno.
 */
export interface TimeRange {
  readonly opensAt: string; // "HH:MM"
  readonly closesAt: string; // "HH:MM"
}

export interface WeeklySlot extends TimeRange {
  readonly weekday: Weekday;
}

/**
 * Excepción por fecha (feriado o jornada especial).
 * `ranges` vacío = cerrado todo el día. Una excepción **reemplaza** por
 * completo al horario semanal de esa fecha, no se suma a él.
 */
export interface ScheduleException {
  /** Fecha local en formato "YYYY-MM-DD". */
  readonly date: string;
  readonly ranges: readonly TimeRange[];
}

export interface Schedule {
  readonly weekly: readonly WeeklySlot[];
  readonly exceptions?: readonly ScheduleException[];
}

/** Instante a evaluar, ya expresado en la zona horaria del local. */
export interface LocalMoment {
  /** "YYYY-MM-DD" */
  readonly date: string;
  /** "HH:MM" */
  readonly time: string;
  readonly weekday: Weekday;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Convierte "HH:MM" a minutos desde medianoche. Valida el formato. */
export function toMinutes(time: string): number {
  const m = TIME_RE.exec(time);
  if (!m) {
    throw new ScheduleError(
      `Hora inválida: "${time}". Formato esperado HH:MM.`,
    );
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) {
    throw new ScheduleError(
      `Fecha inválida: "${date}". Formato esperado YYYY-MM-DD.`,
    );
  }
}

/** ¿La franja cruza la medianoche? */
export function crossesMidnight(range: TimeRange): boolean {
  return toMinutes(range.closesAt) <= toMinutes(range.opensAt);
}

/** Día anterior a una fecha "YYYY-MM-DD" (aritmética de calendario en UTC). */
function previousDate(date: string): string {
  assertDate(date);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Día de la semana anterior. */
function previousWeekday(weekday: Weekday): Weekday {
  return ((weekday + 6) % 7) as Weekday;
}

/** Franjas efectivas de una fecha: la excepción manda sobre el horario semanal. */
function rangesFor(
  schedule: Schedule,
  date: string,
  weekday: Weekday,
): readonly TimeRange[] {
  const exception = schedule.exceptions?.find((e) => e.date === date);
  if (exception) return exception.ranges;
  return schedule.weekly.filter((s) => s.weekday === weekday);
}

/**
 * ¿Está abierto en el instante dado?
 *
 * Considera dos orígenes:
 *  1. Las franjas del propio día que contienen la hora.
 *  2. Las franjas del **día anterior** que cruzaron la medianoche y siguen
 *     vigentes (a las 01:00 del martes puede seguir abierta la franja del lunes
 *     20:00→02:00). Omitir esto es el error clásico de los horarios nocturnos.
 *
 * El intervalo es `[apertura, cierre)`: a la hora exacta de cierre ya está
 * cerrado, para que no se acepte un pedido que la cocina no va a preparar.
 */
export function isOpenAt(schedule: Schedule, moment: LocalMoment): boolean {
  assertDate(moment.date);
  const minutes = toMinutes(moment.time);

  // 1) Franjas del día en curso.
  for (const range of rangesFor(schedule, moment.date, moment.weekday)) {
    const opens = toMinutes(range.opensAt);
    const closes = toMinutes(range.closesAt);
    if (crossesMidnight(range)) {
      // Cubre desde la apertura hasta el final del día.
      if (minutes >= opens) return true;
    } else if (minutes >= opens && minutes < closes) {
      return true;
    }
  }

  // 2) Franjas del día anterior que se prolongan pasada la medianoche.
  const prevDate = previousDate(moment.date);
  const prevWeekday = previousWeekday(moment.weekday);
  for (const range of rangesFor(schedule, prevDate, prevWeekday)) {
    if (!crossesMidnight(range)) continue;
    if (minutes < toMinutes(range.closesAt)) return true;
  }

  return false;
}

/**
 * Convierte un instante UTC a la hora local de una zona IANA
 * (p. ej. "America/Lima"). Usa `Intl`, disponible en Node y en el navegador,
 * de modo que servidor y PWA resuelven idéntico sin dependencias.
 */
export function toLocalMoment(instant: Date, timeZone: string): LocalMoment {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const parts = formatter.formatToParts(instant);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const weekdayMap: Record<string, Weekday> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const hour = get('hour') === '24' ? '00' : get('hour');
  const weekday = weekdayMap[get('weekday')];
  if (weekday === undefined) {
    throw new ScheduleError(`Zona horaria no reconocida: "${timeZone}".`);
  }

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
    weekday,
  };
}
