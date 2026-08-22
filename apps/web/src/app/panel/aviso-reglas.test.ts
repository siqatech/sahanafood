import { describe, it, expect } from 'vitest';
import {
  quePintar,
  corren,
  camposDeDeshacer,
  SEGUNDOS_PARA_DESHACER,
} from './aviso-reglas';

describe('quePintar', () => {
  const base = { restan: SEGUNDOS_PARA_DESHACER, cerrado: false };

  it('el «hecho» se ve mientras quede cuenta atrás', () => {
    expect(quePintar({ ...base, ok: 'Precio guardado.' })).toBe('ok');
    expect(quePintar({ ...base, ok: 'Precio guardado.', restan: 1 })).toBe(
      'ok',
    );
  });

  it('el «hecho» DESAPARECE al llegar a cero', () => {
    expect(quePintar({ ...base, ok: 'Precio guardado.', restan: 0 })).toBe(
      'nada',
    );
  });

  it('el ERROR no caduca: sigue ahí con la cuenta a cero', () => {
    // Es la regla que más importa. Un error que se va solo deja al operador
    // creyendo que guardó cuando no guardó, y en una carta eso significa
    // cobrar el precio viejo toda la tarde.
    expect(
      quePintar({ ...base, error: 'No se pudo guardar.', restan: 0 }),
    ).toBe('error');
    expect(
      quePintar({ ...base, error: 'No se pudo guardar.', restan: -50 }),
    ).toBe('error');
  });

  it('si llegan los dos gana el error: la mala noticia es la que hay que leer', () => {
    expect(
      quePintar({ ...base, ok: 'Guardado.', error: 'No se pudo guardar.' }),
    ).toBe('error');
  });

  it('cerrado a mano no se pinta nada, ni siquiera el error', () => {
    expect(
      quePintar({ ...base, error: 'No se pudo guardar.', cerrado: true }),
    ).toBe('nada');
  });

  it('sin mensaje no hay aviso', () => {
    expect(quePintar(base)).toBe('nada');
  });
});

describe('corren', () => {
  it('el reloj solo corre para el «hecho»', () => {
    expect(corren({ ok: 'Guardado.' })).toBe(true);
    expect(corren({ error: 'Falló.' })).toBe(false);
    expect(corren({})).toBe(false);
  });

  it('con error a la vez NO corre: arrancarlo sería esconder el error', () => {
    expect(corren({ ok: 'Guardado.', error: 'Falló.' })).toBe(false);
  });
});

describe('camposDeDeshacer', () => {
  it('añade la marca que corta el bucle de deshacer-el-deshacer', () => {
    expect(camposDeDeshacer({ productId: 'p1', price: '32.00' })).toEqual({
      productId: 'p1',
      price: '32.00',
      esDeshacer: '1',
    });
  });

  it('no deja que los campos pisen la marca', () => {
    // Un `esDeshacer` que viniera de fuera con otro valor rompería el corte.
    expect(camposDeDeshacer({ esDeshacer: 'no' })).toEqual({
      esDeshacer: '1',
    });
  });
});
