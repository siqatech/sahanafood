import { describe, it, expect } from 'vitest';
import {
  asuntosPendientes,
  hayAlgoQueAtender,
  type EntradaDeAtencion,
} from './atencion-reglas';

const nada: EntradaDeAtencion = {
  pedidosApartados: 0,
  comprobantesRechazados: 0,
  cajasSinCerrar: 0,
  insumosBajoMinimo: 0,
};

describe('asuntosPendientes', () => {
  it('con todo en orden no dice NADA', () => {
    // Un bloque que aparece siempre, aunque sea para decir «no hay nada», es un
    // bloque que se deja de leer; y entonces tampoco se lee el día que sí hay.
    expect(asuntosPendientes(nada)).toEqual([]);
    expect(hayAlgoQueAtender(nada)).toBe(false);
  });

  it('solo lista lo que de verdad hay, no ceros', () => {
    const l = asuntosPendientes({ ...nada, comprobantesRechazados: 2 });
    expect(l).toHaveLength(1);
    expect(l[0]!.clave).toBe('comprobantes');
  });

  it('ORDENA por quién está esperando, no por cantidad', () => {
    // Cuarenta insumos bajo mínimo siguen yendo DESPUÉS de un solo pedido
    // apartado: en el pedido hay una persona esperando ahora mismo; en el
    // inventario todavía no ha pasado nada.
    const l = asuntosPendientes({
      pedidosApartados: 1,
      comprobantesRechazados: 3,
      cajasSinCerrar: 2,
      insumosBajoMinimo: 40,
    });
    expect(l.map((a) => a.clave)).toEqual([
      'excepciones',
      'comprobantes',
      'caja',
      'inventario',
    ]);
  });

  it('solo el pedido apartado es URGENTE', () => {
    // Es el único con alguien esperando al otro lado. Marcar todo como urgente
    // es no marcar nada.
    const l = asuntosPendientes({
      pedidosApartados: 1,
      comprobantesRechazados: 1,
      cajasSinCerrar: 1,
      insumosBajoMinimo: 1,
    });
    expect(l.filter((a) => a.urgente).map((a) => a.clave)).toEqual([
      'excepciones',
    ]);
  });

  it('el singular no dice «1 pedidos»', () => {
    const uno = asuntosPendientes({ ...nada, pedidosApartados: 1 })[0]!;
    expect(uno.titulo).toBe('Un pedido esperando que alguien lo mire');

    const dos = asuntosPendientes({ ...nada, pedidosApartados: 2 })[0]!;
    expect(dos.titulo).toBe('2 pedidos esperando que alguien los mire');
  });

  it('cada asunto dice la CONSECUENCIA y adónde ir', () => {
    // Un contador sin consecuencia es solo un número: «3 comprobantes
    // rechazados» no mueve a nadie hasta que dice que son ventas sin declarar.
    for (const a of asuntosPendientes({
      pedidosApartados: 1,
      comprobantesRechazados: 1,
      cajasSinCerrar: 1,
      insumosBajoMinimo: 1,
    })) {
      expect(a.consecuencia.length).toBeGreaterThan(30);
      expect(a.href.startsWith('/panel/')).toBe(true);
    }
  });
});
