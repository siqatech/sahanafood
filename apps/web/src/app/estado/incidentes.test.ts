import { describe, it, expect } from 'vitest';
import {
  ordenados,
  abiertos,
  diasSinIncidentes,
  INCIDENTES,
  type Incidente,
} from './incidentes';

const inc = (over: Partial<Incidente> = {}): Incidente => ({
  fecha: '2026-08-01',
  titulo: 'No se podía cobrar con tarjeta',
  estado: 'resuelto',
  duracion: 'unos 40 minutos',
  queFallo: 'Los cobros con tarjeta fallaban.',
  queSeHizo: 'Se añadió un reintento y una alarma que avisa antes.',
  ...over,
});

describe('ordenados', () => {
  it('lo más reciente primero, sin fiarse del orden del archivo', () => {
    const l = ordenados([
      inc({ fecha: '2026-01-05' }),
      inc({ fecha: '2026-08-01' }),
      inc({ fecha: '2026-03-20' }),
    ]);
    expect(l.map((i) => i.fecha)).toEqual([
      '2026-08-01',
      '2026-03-20',
      '2026-01-05',
    ]);
  });
});

describe('abiertos', () => {
  it('investigando y vigilando siguen abiertos; resuelto no', () => {
    const l = abiertos([
      inc({ fecha: '2026-08-01', estado: 'resuelto' }),
      inc({ fecha: '2026-08-02', estado: 'investigando' }),
      inc({ fecha: '2026-08-03', estado: 'vigilando' }),
    ]);
    expect(l.map((i) => i.estado)).toEqual(['vigilando', 'investigando']);
  });
});

describe('diasSinIncidentes', () => {
  const ahora = new Date('2026-08-23T12:00:00Z');

  it('cuenta desde el último incidente', () => {
    expect(diasSinIncidentes([inc({ fecha: '2026-08-13' })], ahora)).toBe(10);
  });

  it('con uno ABIERTO no presume tranquilidad', () => {
    // Enseñar «22 días sin incidentes» mientras algo está roto es justo la
    // clase de dato que hace que nadie vuelva a creerse la página.
    expect(
      diasSinIncidentes(
        [
          inc({ fecha: '2026-08-01' }),
          inc({ fecha: '2026-08-20', estado: 'investigando' }),
        ],
        ahora,
      ),
    ).toBeNull();
  });

  it('SIN historial devuelve null, no cero', () => {
    // «0 días sin incidentes» y «nunca ha habido uno» son cosas distintas, y
    // decir la primera por la segunda asusta sin motivo.
    expect(diasSinIncidentes([], ahora)).toBeNull();
  });

  it('una fecha con formato roto no inventa un número', () => {
    expect(diasSinIncidentes([inc({ fecha: 'ayer' })], ahora)).toBeNull();
  });
});

describe('el archivo real', () => {
  it('cada incidente dice QUÉ SE HIZO, no solo qué pasó', () => {
    // Es la única parte que le importa a quien está decidiendo si confiar en
    // nosotros el año que viene. Un incidente sin esa línea es una disculpa,
    // no un postmortem, y esta prueba impide que se cuele uno así el día de
    // prisas en que se escribe con el incidente todavía caliente.
    for (const i of INCIDENTES) {
      expect(
        i.queSeHizo.trim().length,
        `«${i.titulo}» sin qué se hizo`,
      ).toBeGreaterThan(20);
      expect(
        i.queFallo.trim().length,
        `«${i.titulo}» sin qué falló`,
      ).toBeGreaterThan(10);
      expect(i.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
