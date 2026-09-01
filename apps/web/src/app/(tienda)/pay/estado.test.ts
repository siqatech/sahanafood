import { describe, it, expect } from 'vitest';
import { PAYMENT_STATES } from '@sahana/domain';
import { leerPago, horaDeCaducidad } from './estado';

describe('leerPago', () => {
  it('ofrece pagar solo cuando queda algo por pagar', () => {
    expect(leerPago('pending').sePuedePagar).toBe(true);
    // Un intento fallido SÍ se puede reintentar: es la mitad del valor de un
    // enlace de pago, que la tarjeta rechazada no obligue a rehacer el pedido.
    expect(leerPago('failed').sePuedePagar).toBe(true);
  });

  it('NO ofrece pagar lo que ya está pagado o en curso', () => {
    // Es el error caro de esta pantalla: un botón de pagar sobre un cobro ya
    // autorizado es un cliente que paga dos veces y una devolución que hacer.
    expect(leerPago('authorized').sePuedePagar).toBe(false);
    expect(leerPago('captured').sePuedePagar).toBe(false);
    expect(leerPago('refunded').sePuedePagar).toBe(false);
    expect(leerPago('expired').sePuedePagar).toBe(false);
  });

  it('un estado desconocido NO se ofrece como pagable', () => {
    const l = leerPago('inventado');
    expect(l.sePuedePagar).toBe(false);
    expect(l.detalle).toMatch(/Escríbenos/);
  });

  it('cubre TODOS los estados del dominio', () => {
    // Si mañana se añade un estado a `PAYMENT_STATES` y nadie escribe aquí qué
    // se le dice al comprador, esta prueba lo caza antes de que un cliente vea
    // «no podemos cobrar por aquí» sobre un cobro perfectamente vivo.
    for (const estado of PAYMENT_STATES) {
      const l = leerPago(estado);
      expect(l.titulo, `falta el texto de «${estado}»`).not.toBe(
        'No podemos cobrar por aquí ahora mismo',
      );
      expect(l.detalle.length).toBeGreaterThan(10);
    }
  });

  it('el aviso de no pagar dos veces está escrito, no implícito', () => {
    expect(leerPago('authorized').detalle).toMatch(/No vuelvas a pagar/);
  });
});

describe('horaDeCaducidad', () => {
  it('dice una hora concreta de Lima, no un tiempo restante', () => {
    const texto = horaDeCaducidad('2026-09-01T18:30:00.000Z');
    // 18:30 UTC es la 1:30 de la tarde en Lima, y en `es-PE` se lee en formato
    // de 12 horas — que es como lo dice cualquiera aquí. Lo que importa es que
    // sea una hora FIJA y no algo que envejezca en la pantalla del cliente.
    expect(texto).toContain('01:30');
    expect(texto).toMatch(/p\.\s?m\./);
    expect(texto).not.toMatch(/minuto|hora[s]? restante/);
  });

  it('la hora es la de Lima y no la del servidor', () => {
    // Un servidor en UTC diría «06:30 p. m.» de lo mismo: cinco horas de más
    // en un enlace que caduca, y un cliente que llega tarde a pagar.
    expect(horaDeCaducidad('2026-09-01T18:30:00.000Z')).not.toContain('06:30');
  });
});
