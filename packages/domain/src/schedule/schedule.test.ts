import { describe, it, expect } from 'vitest';
import {
  isOpenAt,
  crossesMidnight,
  toMinutes,
  toLocalMoment,
  ScheduleError,
  type Schedule,
  type LocalMoment,
} from './schedule.js';

/** Ayuda: 2026-08-10 es lunes (weekday 1). */
const lunes = (time: string): LocalMoment => ({
  date: '2026-08-10',
  time,
  weekday: 1,
});
const martes = (time: string): LocalMoment => ({
  date: '2026-08-11',
  time,
  weekday: 2,
});

describe('toMinutes', () => {
  it('convierte HH:MM a minutos', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('12:30')).toBe(750);
    expect(toMinutes('23:59')).toBe(1439);
  });

  it('rechaza formatos inválidos', () => {
    expect(() => toMinutes('24:00')).toThrow(ScheduleError);
    expect(() => toMinutes('12:60')).toThrow(ScheduleError);
    expect(() => toMinutes('9:00')).toThrow(ScheduleError);
    expect(() => toMinutes('mediodía')).toThrow(ScheduleError);
  });
});

describe('Horario simple (no cruza medianoche)', () => {
  const schedule: Schedule = {
    weekly: [{ weekday: 1, opensAt: '09:00', closesAt: '18:00' }],
  };

  it('abierto dentro de la franja', () => {
    expect(isOpenAt(schedule, lunes('12:00'))).toBe(true);
  });

  it('abierto justo en la apertura', () => {
    expect(isOpenAt(schedule, lunes('09:00'))).toBe(true);
  });

  it('CERRADO justo en la hora de cierre (intervalo semiabierto)', () => {
    // Regla explícita: a las 18:00 ya no se acepta pedido que la cocina no hará.
    expect(isOpenAt(schedule, lunes('18:00'))).toBe(false);
    expect(isOpenAt(schedule, lunes('17:59'))).toBe(true);
  });

  it('cerrado fuera de la franja', () => {
    expect(isOpenAt(schedule, lunes('08:59'))).toBe(false);
    expect(isOpenAt(schedule, lunes('23:00'))).toBe(false);
  });

  it('cerrado otro día de la semana', () => {
    expect(isOpenAt(schedule, martes('12:00'))).toBe(false);
  });
});

describe('Horario que CRUZA MEDIANOCHE (caso exigido por la spec)', () => {
  // Lunes 20:00 → martes 02:00.
  const schedule: Schedule = {
    weekly: [{ weekday: 1, opensAt: '20:00', closesAt: '02:00' }],
  };

  it('crossesMidnight lo detecta', () => {
    expect(crossesMidnight({ opensAt: '20:00', closesAt: '02:00' })).toBe(true);
    expect(crossesMidnight({ opensAt: '09:00', closesAt: '18:00' })).toBe(
      false,
    );
    // Franja de 24 h: apertura == cierre también se considera cruce.
    expect(crossesMidnight({ opensAt: '00:00', closesAt: '00:00' })).toBe(true);
  });

  it('abierto la noche del lunes', () => {
    expect(isOpenAt(schedule, lunes('20:00'))).toBe(true);
    expect(isOpenAt(schedule, lunes('23:59'))).toBe(true);
  });

  it('SIGUE abierto la madrugada del martes (la franja del lunes continúa)', () => {
    expect(isOpenAt(schedule, martes('00:30'))).toBe(true);
    expect(isOpenAt(schedule, martes('01:59'))).toBe(true);
  });

  it('cierra a las 02:00 del martes', () => {
    expect(isOpenAt(schedule, martes('02:00'))).toBe(false);
    expect(isOpenAt(schedule, martes('03:00'))).toBe(false);
  });

  it('cerrado el lunes por la tarde, antes de abrir', () => {
    expect(isOpenAt(schedule, lunes('19:59'))).toBe(false);
  });

  it('la madrugada del propio lunes NO está cubierta (la abre el domingo)', () => {
    expect(isOpenAt(schedule, lunes('01:00'))).toBe(false);
  });
});

describe('Excepciones por fecha (feriados)', () => {
  const schedule: Schedule = {
    weekly: [{ weekday: 1, opensAt: '09:00', closesAt: '18:00' }],
    exceptions: [
      // Feriado: cerrado todo el día.
      { date: '2026-08-10', ranges: [] },
    ],
  };

  it('una excepción vacía cierra el día completo', () => {
    expect(isOpenAt(schedule, lunes('12:00'))).toBe(false);
  });

  it('una excepción con horario REEMPLAZA al semanal, no se suma', () => {
    const especial: Schedule = {
      weekly: [{ weekday: 1, opensAt: '09:00', closesAt: '18:00' }],
      exceptions: [
        {
          date: '2026-08-10',
          ranges: [{ opensAt: '15:00', closesAt: '20:00' }],
        },
      ],
    };
    // Dentro del horario semanal pero fuera del excepcional → cerrado.
    expect(isOpenAt(especial, lunes('10:00'))).toBe(false);
    // Dentro del excepcional → abierto.
    expect(isOpenAt(especial, lunes('19:00'))).toBe(true);
  });

  it('una excepción del día anterior también puede cruzar medianoche', () => {
    const especial: Schedule = {
      weekly: [],
      exceptions: [
        {
          date: '2026-08-10',
          ranges: [{ opensAt: '22:00', closesAt: '03:00' }],
        },
      ],
    };
    expect(isOpenAt(especial, lunes('23:00'))).toBe(true);
    expect(isOpenAt(especial, martes('02:00'))).toBe(true);
    expect(isOpenAt(especial, martes('03:00'))).toBe(false);
  });

  it('rechaza fechas mal formadas', () => {
    expect(() =>
      isOpenAt(schedule, { date: '10/08/2026', time: '12:00', weekday: 1 }),
    ).toThrow(ScheduleError);
  });
});

describe('Varias franjas el mismo día (turno partido)', () => {
  const schedule: Schedule = {
    weekly: [
      { weekday: 1, opensAt: '08:00', closesAt: '14:00' },
      { weekday: 1, opensAt: '19:00', closesAt: '23:00' },
    ],
  };

  it('abierto en ambas franjas', () => {
    expect(isOpenAt(schedule, lunes('09:00'))).toBe(true);
    expect(isOpenAt(schedule, lunes('20:00'))).toBe(true);
  });

  it('cerrado en el intermedio', () => {
    expect(isOpenAt(schedule, lunes('16:00'))).toBe(false);
  });
});

describe('Sin horario definido', () => {
  it('un horario vacío está siempre cerrado', () => {
    expect(isOpenAt({ weekly: [] }, lunes('12:00'))).toBe(false);
  });
});

describe('toLocalMoment — conversión a zona del local', () => {
  it('convierte UTC a America/Lima (UTC-5)', () => {
    // 2026-08-10T15:30:00Z → 10:30 del lunes en Lima.
    const m = toLocalMoment(new Date('2026-08-10T15:30:00Z'), 'America/Lima');
    expect(m.date).toBe('2026-08-10');
    expect(m.time).toBe('10:30');
    expect(m.weekday).toBe(1); // lunes
  });

  it('cruza el día correctamente al restar 5 horas', () => {
    // 2026-08-11T03:00:00Z → 22:00 del lunes 10 en Lima.
    const m = toLocalMoment(new Date('2026-08-11T03:00:00Z'), 'America/Lima');
    expect(m.date).toBe('2026-08-10');
    expect(m.time).toBe('22:00');
    expect(m.weekday).toBe(1);
  });

  it('la medianoche local se expresa como 00:00, no 24:00', () => {
    // 2026-08-11T05:00:00Z → 00:00 del martes 11 en Lima.
    const m = toLocalMoment(new Date('2026-08-11T05:00:00Z'), 'America/Lima');
    expect(m.time).toBe('00:00');
    expect(m.date).toBe('2026-08-11');
    expect(m.weekday).toBe(2);
  });

  it('se integra con isOpenAt para el caso nocturno real', () => {
    const schedule: Schedule = {
      weekly: [{ weekday: 1, opensAt: '20:00', closesAt: '02:00' }],
    };
    // 01:00 del martes en Lima = 06:00Z del martes.
    const m = toLocalMoment(new Date('2026-08-11T06:00:00Z'), 'America/Lima');
    expect(isOpenAt(schedule, m)).toBe(true);
  });

  it('rechaza zona horaria inválida', () => {
    expect(() => toLocalMoment(new Date(), 'Marte/Olympus')).toThrow();
  });
});
