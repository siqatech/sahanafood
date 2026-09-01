import { describe, it, expect } from 'vitest';
import type { RespuestaRapida } from '../../../lib/panel-api';
import {
  revisarAtajo,
  revisarCuerpo,
  expandirAtajos,
  insertar,
} from './atajos';

const RESPUESTAS: RespuestaRapida[] = [
  {
    id: '1',
    brandId: null,
    shortcut: 'recojo',
    body: 'Puedes recogerlo en Av. Pardo 123, Miraflores.',
  },
  {
    id: '2',
    brandId: null,
    shortcut: 'horario',
    body: 'Abrimos de 11:00 a 23:00 todos los días.',
  },
];

describe('revisarAtajo', () => {
  it('quita la barra y baja a minúsculas', () => {
    expect(revisarAtajo('/Recojo')).toEqual({ atajo: 'recojo' });
    expect(revisarAtajo('  RECOJO  ')).toEqual({ atajo: 'recojo' });
  });

  it('rechaza los espacios, que es lo que rompe el tecleo', () => {
    const r = revisarAtajo('/av pardo');
    expect(r).toHaveProperty('error');
    expect('error' in r && r.error).toMatch(/sin espacios/);
  });

  it('rechaza el vacío y lo demasiado corto', () => {
    expect(revisarAtajo('')).toHaveProperty('error');
    expect(revisarAtajo('/')).toHaveProperty('error');
    expect(revisarAtajo('/a')).toHaveProperty('error');
    expect(revisarAtajo('/ab')).toEqual({ atajo: 'ab' });
  });

  it('rechaza lo demasiado largo', () => {
    expect(revisarAtajo(`/${'a'.repeat(41)}`)).toHaveProperty('error');
  });
});

describe('revisarCuerpo', () => {
  it('exige texto y lo recorta', () => {
    expect(revisarCuerpo('  hola  ')).toEqual({ cuerpo: 'hola' });
    expect(revisarCuerpo('   ')).toHaveProperty('error');
  });
});

describe('expandirAtajos', () => {
  it('sustituye el atajo por su texto', () => {
    expect(expandirAtajos('/recojo', RESPUESTAS)).toBe(
      'Puedes recogerlo en Av. Pardo 123, Miraflores.',
    );
  });

  it('sustituye dentro de una frase y conserva lo de alrededor', () => {
    expect(expandirAtajos('Claro. /horario Gracias.', RESPUESTAS)).toBe(
      'Claro. Abrimos de 11:00 a 23:00 todos los días. Gracias.',
    );
  });

  it('DEJA INTACTO lo que no reconoce, para que se vea antes de enviar', () => {
    // Tragarse un `/recojoo` mal escrito mandaría el mensaje sin el dato, y el
    // cliente se quedaría sin la dirección sin que nadie se enterase.
    expect(expandirAtajos('te espero en /recojoo', RESPUESTAS)).toBe(
      'te espero en /recojoo',
    );
  });

  it('no toca una barra pegada a otra palabra, que suele ser una fecha o una URL', () => {
    expect(expandirAtajos('el 12/recojo del mes', RESPUESTAS)).toBe(
      'el 12/recojo del mes',
    );
  });

  it('no distingue mayúsculas', () => {
    expect(expandirAtajos('/RECOJO', RESPUESTAS)).toBe(
      'Puedes recogerlo en Av. Pardo 123, Miraflores.',
    );
  });

  it('sin respuestas configuradas devuelve el texto tal cual', () => {
    expect(expandirAtajos('/recojo', [])).toBe('/recojo');
  });
});

describe('insertar', () => {
  it('añade en una línea nueva sin perder lo ya escrito', () => {
    expect(insertar('Hola Ana,', 'Abrimos de 11:00 a 23:00.')).toBe(
      'Hola Ana,\nAbrimos de 11:00 a 23:00.',
    );
  });

  it('en un campo vacío pone solo el texto', () => {
    expect(insertar('', 'Abrimos a las 11.')).toBe('Abrimos a las 11.');
    expect(insertar('   \n ', 'Abrimos a las 11.')).toBe('Abrimos a las 11.');
  });
});
