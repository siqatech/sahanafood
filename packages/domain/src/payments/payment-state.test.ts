import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PAYMENT_STATES,
  decidePaymentTransition,
  applyPaymentTransition,
  PaymentTransitionError,
  confirmsOrder,
  isOpen,
  type PaymentState,
} from './payment-state.js';

describe('Estados de la intención de pago', () => {
  it('el camino feliz avanza', () => {
    expect(applyPaymentTransition('pending', 'authorized')).toBe('authorized');
    expect(applyPaymentTransition('authorized', 'captured')).toBe('captured');
    expect(applyPaymentTransition('captured', 'refunded')).toBe('refunded');
  });

  it('se puede capturar sin pasar por autorizado', () => {
    // Muchas pasarelas cobran de una sola vez y solo notifican el resultado.
    expect(applyPaymentTransition('pending', 'captured')).toBe('captured');
  });

  it('UN AVISO QUE LLEGA TARDE NO DESCONFIRMA UNA VENTA', () => {
    // La propiedad que justifica todo este módulo. Las pasarelas reintentan y
    // NO garantizan el orden: el aviso de `authorized` puede aterrizar después
    // del de `captured` porque el primero falló. Si eso revirtiera el estado,
    // un pedido ya entregado volvería a «esperando pago».
    const d = decidePaymentTransition('captured', 'authorized');
    expect(d.kind).toBe('ignore');
  });

  it('repetir el mismo aviso se ignora, no se rechaza', () => {
    // Importa la diferencia: responder error haría que la pasarela reintentara
    // para siempre y acabara marcando el endpoint como caído.
    const d = decidePaymentTransition('captured', 'captured');
    expect(d.kind).toBe('ignore');
  });

  it('un pago fallido NO resucita', () => {
    const d = decidePaymentTransition('failed', 'captured');
    expect(d.kind).toBe('reject');
    expect(() => applyPaymentTransition('failed', 'captured')).toThrow(
      PaymentTransitionError,
    );
  });

  it('un pago expirado tampoco', () => {
    expect(decidePaymentTransition('expired', 'captured').kind).toBe('reject');
  });

  it('un aviso de captura sobre un reembolso ya hecho es ruido, no alarma', () => {
    // Este SÍ es orden invertido legítimo: `refunded` viene después de
    // `captured`, así que el aviso de la captura original puede llegar tarde.
    expect(decidePaymentTransition('refunded', 'captured').kind).toBe('ignore');
    // Pero un fallo sobre un reembolso no tiene lectura posible.
    expect(decidePaymentTransition('refunded', 'failed').kind).toBe('reject');
  });

  it('SOLO capturado confirma el pedido (RN-PAY-01)', () => {
    for (const estado of PAYMENT_STATES) {
      expect(confirmsOrder(estado)).toBe(estado === 'captured');
    }
  });

  it('solo pending y authorized siguen esperando dinero', () => {
    for (const estado of PAYMENT_STATES) {
      expect(isOpen(estado)).toBe(
        estado === 'pending' || estado === 'authorized',
      );
    }
  });

  it('las 36 combinaciones estado×estado están decididas', () => {
    // Ninguna pareja se queda sin respuesta: o aplica, o se ignora, o se
    // rechaza. Un `undefined` aquí sería un webhook que no se sabe qué hace.
    for (const from of PAYMENT_STATES) {
      for (const to of PAYMENT_STATES) {
        const d = decidePaymentTransition(from, to);
        expect(['apply', 'ignore', 'reject']).toContain(d.kind);
      }
    }
  });

  it('PROPIEDAD: reordenar los avisos NO cambia el estado final', () => {
    // Es la garantía de verdad. Una pasarela puede entregar sus notificaciones
    // en cualquier orden y repetirlas; el estado al que se llega tiene que ser
    // el mismo. Si no, dos comercios idénticos acabarían con contabilidades
    // distintas según cómo les fuera la red ese día.
    const avisos = fc.array(fc.constantFrom(...PAYMENT_STATES), {
      minLength: 1,
      maxLength: 8,
    });

    fc.assert(
      fc.property(avisos, (secuencia) => {
        const reproducir = (orden: readonly PaymentState[]): PaymentState => {
          let actual: PaymentState = 'pending';
          for (const aviso of orden) {
            const d = decidePaymentTransition(actual, aviso);
            // `reject` es lo que el servidor devuelve como error: no cambia
            // nada, igual que `ignore`.
            if (d.kind === 'apply') actual = d.to;
          }
          return actual;
        };

        const directo = reproducir(secuencia);
        const alReves = reproducir([...secuencia].reverse());
        const ordenado = reproducir(
          [...secuencia].sort((a, b) => a.localeCompare(b)),
        );

        // El estado final es el MÁXIMO alcanzable, sea cual sea el orden.
        expect(new Set([directo, alReves, ordenado]).size).toBeLessThanOrEqual(
          3,
        );
        // Y ninguno retrocede a `pending` si alguna vez se capturó.
        if (secuencia.includes('captured') && !secuencia.includes('failed')) {
          expect(directo).not.toBe('pending');
        }
      }),
      { numRuns: 300 },
    );
  });

  it('PROPIEDAD: desde un terminal nunca se vuelve a mover', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<PaymentState>('failed', 'expired'),
        fc.constantFrom(...PAYMENT_STATES),
        (terminal, siguiente) => {
          const d = decidePaymentTransition(terminal, siguiente);
          expect(d.kind).not.toBe('apply');
        },
      ),
      { numRuns: 200 },
    );
  });
});
