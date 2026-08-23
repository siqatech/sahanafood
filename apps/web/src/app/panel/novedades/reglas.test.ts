import { describe, it, expect } from 'vitest';
import { ordenadas, sinLeer, fechaMasReciente } from './reglas';
import { NOVEDADES, type Novedad } from './datos';

const n = (fecha: string): Novedad => ({
  fecha,
  titulo: `Novedad de ${fecha}`,
  detalle: 'Da igual el texto para estas pruebas.',
});

describe('ordenadas', () => {
  it('de la más reciente a la más antigua, pase lo que pase en el archivo', () => {
    // Una entrada nueva pegada al final por descuido saldría la última, que es
    // justo donde no se ve.
    const lista = ordenadas([
      n('2026-01-01'),
      n('2026-08-22'),
      n('2026-03-15'),
    ]);
    expect(lista.map((x) => x.fecha)).toEqual([
      '2026-08-22',
      '2026-03-15',
      '2026-01-01',
    ]);
  });

  it('no toca la lista original', () => {
    const original = [n('2026-01-01'), n('2026-08-22')];
    ordenadas(original);
    expect(original[0]!.fecha).toBe('2026-01-01');
  });
});

describe('sinLeer', () => {
  const lista = [n('2026-08-22'), n('2026-08-10'), n('2026-07-01')];

  it('cuenta solo las POSTERIORES a lo último visto', () => {
    expect(sinLeer(lista, '2026-08-10')).toBe(1);
    expect(sinLeer(lista, '2026-07-01')).toBe(2);
  });

  it('al día devuelve cero', () => {
    expect(sinLeer(lista, '2026-08-22')).toBe(0);
    // Y una fecha futura tampoco cuenta hacia atrás.
    expect(sinLeer(lista, '2027-01-01')).toBe(0);
  });

  it('SIN NADA GUARDADO devuelve cero, no todas', () => {
    // Quien entra por primera vez ya tiene la portada llena de cosas que
    // aprender. Recibirlo con «9 novedades» de funciones que nunca echó de
    // menos es ruido, y el ruido del primer día es el que enseña a ignorar el
    // aviso para siempre.
    expect(sinLeer(lista, null)).toBe(0);
  });

  it('una fecha guardada ILEGIBLE se trata como si no hubiera nada', () => {
    // `localStorage` lo puede tocar cualquiera, y un valor roto no debe
    // convertirse en un aviso permanente que no se puede quitar.
    expect(sinLeer(lista, 'ayer')).toBe(0);
    expect(sinLeer(lista, '')).toBe(0);
    expect(sinLeer(lista, '2026-8-1')).toBe(0);
  });
});

describe('fechaMasReciente', () => {
  it('es la que hay que guardar al mirar la pantalla', () => {
    expect(fechaMasReciente([n('2026-01-01'), n('2026-08-22')])).toBe(
      '2026-08-22',
    );
  });

  it('sin novedades no hay nada que guardar', () => {
    expect(fechaMasReciente([])).toBeNull();
  });
});

describe('el archivo de novedades', () => {
  it('está escrito en lengua de OPERADOR, no de programador', () => {
    // La regla de docs/26. Estas palabras son las que se cuelan cuando uno
    // escribe la novedad pensando en el commit que acaba de hacer.
    const jerga =
      /\b(endpoint|API|CSV|migración|refactor|componente|servicio|deploy|commit|backend|frontend)\b/i;
    for (const novedad of NOVEDADES) {
      expect(
        jerga.test(`${novedad.titulo} ${novedad.detalle}`),
        `«${novedad.titulo}» usa jerga técnica`,
      ).toBe(false);
    }
  });

  it('cada novedad tiene fecha válida y algo que contar', () => {
    for (const novedad of NOVEDADES) {
      expect(novedad.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(novedad.detalle.length).toBeGreaterThan(30);
      // Si dice dónde, que sea una ruta del panel y no una frase.
      if (novedad.donde) expect(novedad.donde.startsWith('/panel')).toBe(true);
    }
  });
});
