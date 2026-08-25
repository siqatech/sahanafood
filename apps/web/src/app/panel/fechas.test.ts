import { describe, it, expect } from 'vitest';
import { diaConSemana, horaSola, momento, esHoy } from './fechas';

/**
 * Todas las pruebas fijan «ahora» a propósito: una que dependa del reloj de la
 * máquina pasa hoy y falla en Nochevieja, que es exactamente el día en que
 * nadie está mirando.
 */
const AHORA = new Date('2026-08-23T15:00:00Z');

describe('diaConSemana', () => {
  it('lleva el día de la semana, que es como piensa un operador', () => {
    // 2026-08-22 fue sábado. Un negocio de comida tiene picos semanales: la
    // pregunta real ante un listado es «¿fue un día fuerte o un martes?».
    const t = diaConSemana('2026-08-22T18:00:00Z', AHORA);
    expect(t).toMatch(/^sá?b/i);
    expect(t).toContain('22');
    expect(t.toLowerCase()).toContain('ago');
  });

  it('OMITE el año cuando es el año en curso', () => {
    expect(diaConSemana('2026-08-22T18:00:00Z', AHORA)).not.toContain('2026');
  });

  it('y lo PONE cuando no lo es', () => {
    expect(diaConSemana('2024-03-05T18:00:00Z', AHORA)).toContain('2024');
  });

  it('usa la hora de LIMA, no la de UTC', () => {
    // 2026-08-23T02:30Z es todavía el 22 por la noche en Lima (UTC-5). Con UTC
    // esta venta se contaría en el día siguiente, y el cuadre de caja del
    // sábado no cuadraría con el listado.
    const t = diaConSemana('2026-08-23T02:30:00Z', AHORA);
    expect(t).toContain('22');
  });

  it('una fecha inválida no rompe la pantalla', () => {
    expect(diaConSemana('esto no es una fecha', AHORA)).toBe('—');
  });
});

describe('horaSola', () => {
  it('da la hora de Lima en 24 h', () => {
    // 20:30 UTC = 15:30 en Lima.
    expect(horaSola('2026-08-22T20:30:00Z')).toBe('15:30');
  });

  it('no rompe con basura', () => {
    expect(horaSola('')).toBe('—');
  });
});

describe('momento', () => {
  it('junta día y hora', () => {
    const t = momento('2026-08-22T20:30:00Z', AHORA);
    expect(t).toContain('22');
    expect(t).toContain('15:30');
  });

  it('sin fecha devuelve una raya, no «Invalid Date»', () => {
    // Es la mitad del trabajo de estas funciones: los campos opcionales
    // —aceptado, cerrado, entregado— están vacíos casi siempre al principio.
    expect(momento(null, AHORA)).toBe('—');
    expect(momento(undefined, AHORA)).toBe('—');
  });
});

describe('esHoy', () => {
  it('compara el CALENDARIO de Lima, no una resta de horas', () => {
    // A las 00:30 de Lima, un pedido de hace tres horas es de AYER. Con «hace
    // menos de 24 h» saldría como de hoy y descuadraría el cierre del día.
    const medianochePasada = new Date('2026-08-23T05:30:00Z'); // 00:30 en Lima
    expect(esHoy('2026-08-23T02:30:00Z', medianochePasada)).toBe(false);
    expect(esHoy('2026-08-23T05:29:00Z', medianochePasada)).toBe(true);
  });

  it('una fecha inválida no es hoy', () => {
    expect(esHoy('x', AHORA)).toBe(false);
  });
});
