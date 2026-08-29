import { describe, it, expect } from 'vitest';
import { revisarSemana, revisarFeriado, cierraSiempre, DIAS } from './horario';

/**
 * El horario que se teclea.
 *
 * Lo que se defiende: que un error se diga con el nombre del día, y que
 * «cerrado» y «mal escrito» no se confundan. Guardar un horario equivocado no
 * da error en ningún sitio — se descubre cuando un cliente pide con el local
 * cerrado, o cuando la tienda rechaza pedidos con la cocina llena.
 */

/** Simula el `FormData` del formulario de siete filas. */
function formulario(valores: Record<string, string>) {
  return (campo: string) => valores[campo] ?? null;
}

describe('revisarSemana', () => {
  it('lee los días con horas y omite los que están vacíos', () => {
    const r = revisarSemana(
      formulario({
        'abre-1': '12:00',
        'cierra-1': '22:00',
        'abre-6': '12:00',
        'cierra-6': '23:30',
      }),
    );
    expect(r).toEqual({
      weekly: [
        { weekday: 1, opensAt: '12:00', closesAt: '22:00' },
        { weekday: 6, opensAt: '12:00', closesAt: '23:30' },
      ],
    });
  });

  it('un día vacío está CERRADO, y eso no es un error', () => {
    // Hay locales que cierran los lunes. Tratarlo como error obligaría a
    // inventar un horario para un día que no se abre.
    const r = revisarSemana(formulario({}));
    expect('weekly' in r && r.weekly).toEqual([]);
    expect(cierraSiempre([])).toBe(true);
  });

  it('media hora es un error, y lo dice con el nombre del día', () => {
    const r = revisarSemana(formulario({ 'abre-3': '12:00' }));
    expect('error' in r && r.error).toContain('miércoles');
  });

  it('CRUZAR LA MEDIANOCHE está permitido', () => {
    // 18:00–02:00 es lo normal en una pollería, y el dominio lo entiende. Si
    // esto se rechazara, media carta de cenas no se podría configurar.
    const r = revisarSemana(
      formulario({ 'abre-5': '18:00', 'cierra-5': '02:00' }),
    );
    expect('weekly' in r && r.weekly).toEqual([
      { weekday: 5, opensAt: '18:00', closesAt: '02:00' },
    ]);
  });

  it('abrir y cerrar a la misma hora no se adivina', () => {
    // Podría ser cero horas o veinticuatro. Las dos lecturas son defendibles,
    // así que se pregunta en vez de elegir una.
    const r = revisarSemana(
      formulario({ 'abre-0': '00:00', 'cierra-0': '00:00' }),
    );
    expect('error' in r && r.error).toContain('00:00 y 23:59');
  });

  it('rechaza una hora que no es una hora', () => {
    expect(
      'error' in
        revisarSemana(formulario({ 'abre-2': '25:00', 'cierra-2': '22:00' })),
    ).toBe(true);
    expect(
      'error' in
        revisarSemana(formulario({ 'abre-2': '9:00', 'cierra-2': '22:00' })),
    ).toBe(true);
  });

  it('los siete días tienen nombre y ninguno se repite', () => {
    // El índice ES el que espera el dominio (0 = domingo). Un desfase de uno
    // movería el horario entero un día y nadie lo vería hasta el domingo.
    expect(DIAS.map((d) => d.indice)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(DIAS.map((d) => d.nombre)).size).toBe(7);
    expect(DIAS[0]!.nombre).toBe('Domingo');
  });
});

describe('revisarFeriado', () => {
  it('sin horas es cerrado todo el día', () => {
    expect(revisarFeriado('2026-07-28', '', '')).toEqual({
      feriado: { date: '2026-07-28', ranges: [] },
    });
  });

  it('con horas es jornada especial', () => {
    expect(revisarFeriado('2026-12-25', '18:00', '23:00')).toEqual({
      feriado: {
        date: '2026-12-25',
        ranges: [{ opensAt: '18:00', closesAt: '23:00' }],
      },
    });
  });

  it('media hora es un error', () => {
    expect('error' in revisarFeriado('2026-12-25', '18:00', '')).toBe(true);
  });

  it('sin fecha no hay feriado', () => {
    expect('error' in revisarFeriado('', '', '')).toBe(true);
    expect('error' in revisarFeriado('25/12/2026', '', '')).toBe(true);
    expect('error' in revisarFeriado(null, '', '')).toBe(true);
  });
});
