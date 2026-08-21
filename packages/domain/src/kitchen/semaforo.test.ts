import { describe, it, expect } from 'vitest';
import { nivelDeTiempo, UMBRAL_AMBAR } from './semaforo.js';

/**
 * Lo que se prueba es el BORDE, que es lo único que puede estar mal sin que se
 * note: un semáforo que pasa a ámbar un poco tarde parece funcionar en todas
 * las capturas y deja al operador sin margen justo en los pedidos con la
 * promesa más larga.
 */
describe('nivelDeTiempo', () => {
  const inicio = 1_000_000;
  const limite = inicio + 10 * 60_000; // diez minutos, la política por defecto
  const en = (fraccion: number) => inicio + (limite - inicio) * fraccion;

  it('verde mientras queda holgura', () => {
    expect(nivelDeTiempo({ inicio, limite, ahora: en(0) })).toBe('verde');
    expect(nivelDeTiempo({ inicio, limite, ahora: en(0.5) })).toBe('verde');
    expect(nivelDeTiempo({ inicio, limite, ahora: en(0.69) })).toBe('verde');
  });

  it('ámbar EXACTAMENTE al 70 %, que es lo que dice docs/25', () => {
    expect(nivelDeTiempo({ inicio, limite, ahora: en(UMBRAL_AMBAR) })).toBe(
      'ambar',
    );
    expect(nivelDeTiempo({ inicio, limite, ahora: en(0.99) })).toBe('ambar');
  });

  it('rojo al llegar al límite, no un milisegundo después', () => {
    expect(nivelDeTiempo({ inicio, limite, ahora: limite })).toBe('rojo');
    expect(nivelDeTiempo({ inicio, limite, ahora: limite + 1 })).toBe('rojo');
  });

  it('con una política LARGA el ámbar llega igual de pronto, en proporción', () => {
    // El fallo que motivó mover esto a un solo sitio: con un umbral fijo de dos
    // minutos, una promesa de treinta avisaba al 93 % del plazo.
    const largo = inicio + 30 * 60_000;
    const al70 = inicio + 21 * 60_000;
    expect(nivelDeTiempo({ inicio, limite: largo, ahora: al70 - 1 })).toBe(
      'verde',
    );
    expect(nivelDeTiempo({ inicio, limite: largo, ahora: al70 })).toBe('ambar');
  });

  it('una ventana de duración cero o negativa es ROJA, no verde', () => {
    // Un pedido que nace vencido, o dos relojes desincronizados. Pintarlo verde
    // escondería justo el que nadie ha mirado.
    expect(nivelDeTiempo({ inicio, limite: inicio, ahora: inicio })).toBe(
      'rojo',
    );
    expect(
      nivelDeTiempo({ inicio, limite: inicio - 1000, ahora: inicio - 500 }),
    ).toBe('rojo');
  });

  it('antes de que empiece la ventana es verde: no ha corrido nada', () => {
    expect(nivelDeTiempo({ inicio, limite, ahora: inicio - 5000 })).toBe(
      'verde',
    );
  });
});
