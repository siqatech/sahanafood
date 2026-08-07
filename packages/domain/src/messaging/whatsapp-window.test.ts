import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  isWindowOpen,
  decideSend,
  checkMessageBudget,
  isNotifiable,
  STATE_TEMPLATES,
  NOTIFIABLE_ORDER_STATES,
  MessagingError,
  DEFAULT_MESSAGE_BUDGET,
} from './whatsapp-window.js';

/**
 * Esto decide sobre dinero y sobre consentimiento.
 *
 * Meta cobra por mensaje fuera de la ventana de 24 h: mandar plantilla cuando
 * cabía texto libre es pagar de más en cada pedido, e intentar texto libre
 * fuera de ventana no entrega nada y el cliente se queda sin saber que su
 * comida salió.
 */

const AHORA = new Date('2026-08-07T20:00:00Z');
const hace = (horas: number) => new Date(AHORA.getTime() - horas * 3_600_000);

describe('Ventana de servicio de 24 h', () => {
  it('abierta si el cliente escribió hace menos de 24 h', () => {
    expect(
      isWindowOpen({ lastInboundAt: hace(1), optedOut: false }, AHORA),
    ).toBe(true);
    expect(
      isWindowOpen({ lastInboundAt: hace(23.9), optedOut: false }, AHORA),
    ).toBe(true);
  });

  it('cerrada a las 24 h exactas y después', () => {
    expect(
      isWindowOpen({ lastInboundAt: hace(24), optedOut: false }, AHORA),
    ).toBe(false);
    expect(
      isWindowOpen({ lastInboundAt: hace(48), optedOut: false }, AHORA),
    ).toBe(false);
  });

  it('un cliente que NUNCA escribió no tiene ventana', () => {
    expect(isWindowOpen({ optedOut: false }, AHORA)).toBe(false);
    expect(isWindowOpen({ lastInboundAt: null, optedOut: false }, AHORA)).toBe(
      false,
    );
  });

  it('se cuenta desde el ENTRANTE, no desde nuestro último envío', () => {
    // Contarla desde el saliente la mantendría abierta para siempre: bastaría
    // escribirle al cliente para poder volver a escribirle, que es justo lo
    // que la regla de Meta impide. El tipo no admite un `lastOutboundAt`, y
    // eso es la prueba: no hay forma de equivocarse.
    const contacto = { lastInboundAt: hace(30), optedOut: false };
    expect(isWindowOpen(contacto, AHORA)).toBe(false);
  });

  it('un reloj desajustado no abre una ventana infinita', () => {
    const futuro = new Date(AHORA.getTime() + 3_600_000);
    expect(
      isWindowOpen({ lastInboundAt: futuro, optedOut: false }, AHORA),
    ).toBe(true);
  });
});

describe('Decisión de envío', () => {
  it('dentro de ventana manda TEXTO LIBRE: la plantilla se paga', () => {
    const d = decideSend({ lastInboundAt: hace(2), optedOut: false }, AHORA);
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.kind).toBe('freeform');
  });

  it('fuera de ventana manda PLANTILLA: el texto libre no llegaría', () => {
    const d = decideSend({ lastInboundAt: hace(30), optedOut: false }, AHORA);
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.kind).toBe('template');
  });

  it('el OPT-OUT gana incluso con la ventana abierta', () => {
    // Un contacto que se dio de baja hace cinco minutos tiene la ventana
    // abierta; preguntar primero por la ventana daría permiso para escribirle.
    const d = decideSend({ lastInboundAt: hace(0.1), optedOut: true }, AHORA);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('WA_OPTED_OUT');
  });

  it('el opt-out también bloquea fuera de ventana', () => {
    expect(
      decideSend({ lastInboundAt: hace(50), optedOut: true }, AHORA).allowed,
    ).toBe(false);
  });
});

describe('Presupuesto de mensajes (RN-WA-01)', () => {
  it('avisa antes de llegar al objetivo', () => {
    // A partir del cambio de precios de Meta cada mensaje de servicio se
    // cobra: un pedido de S/ 35 con doce notificaciones se come su margen.
    expect(checkMessageBudget(0).status).toBe('ok');
    expect(checkMessageBudget(5).status).toBe('ok');
    expect(checkMessageBudget(6).status).toBe('warning');
    expect(checkMessageBudget(8).status).toBe('over');
    expect(checkMessageBudget(20).status).toBe('over');
  });

  it('informa cuántos quedan', () => {
    expect(checkMessageBudget(3).remaining).toBe(5);
    expect(checkMessageBudget(10).remaining).toBe(-2);
  });

  it('rechaza contadores y presupuestos imposibles', () => {
    expect(() => checkMessageBudget(-1)).toThrow(MessagingError);
    expect(() => checkMessageBudget(1.5)).toThrow(MessagingError);
    expect(() => checkMessageBudget(1, { target: 5, warnAt: 9 })).toThrow(
      /antes del objetivo/,
    );
  });

  it('el objetivo por defecto es el de la spec', () => {
    expect(DEFAULT_MESSAGE_BUDGET.target).toBe(8);
    expect(DEFAULT_MESSAGE_BUDGET.warnAt).toBeLessThan(
      DEFAULT_MESSAGE_BUDGET.target,
    );
  });
});

describe('Qué estados se notifican', () => {
  it('solo los que cambian lo que el cliente puede hacer', () => {
    // Notificar las doce transiciones multiplica el costo por cuatro sin decir
    // nada que importe: nadie necesita saber que pasó de «empacado» a
    // «despachado».
    expect(isNotifiable('accepted')).toBe(true);
    expect(isNotifiable('dispatched')).toBe(true);
    expect(isNotifiable('packed')).toBe(false);
    expect(isNotifiable('ready')).toBe(false);
    expect(isNotifiable('received')).toBe(false);
  });

  it('cada estado notificable tiene su plantilla aprobada', () => {
    // Un estado sin plantilla es una notificación que fallará fuera de
    // ventana, es decir: casi siempre.
    for (const estado of NOTIFIABLE_ORDER_STATES) {
      expect(STATE_TEMPLATES[estado]).toBeTruthy();
    }
    expect(Object.keys(STATE_TEMPLATES)).toHaveLength(
      NOTIFIABLE_ORDER_STATES.length,
    );
  });
});

describe('WhatsApp — propiedades', () => {
  it('un contacto dado de baja NUNCA recibe, con cualquier antigüedad', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), (horas) => {
        const d = decideSend(
          { lastInboundAt: hace(horas), optedOut: true },
          AHORA,
        );
        expect(d.allowed).toBe(false);
      }),
    );
  });

  it('sin opt-out siempre hay una forma de enviar: nunca se pierde un aviso', () => {
    // Dentro de ventana, libre; fuera, plantilla. Lo que no puede pasar es que
    // no haya camino y el cliente se quede sin saber nada.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), (horas) => {
        const d = decideSend(
          { lastInboundAt: hace(horas), optedOut: false },
          AHORA,
        );
        expect(d.allowed).toBe(true);
      }),
    );
  });

  it('el tipo de mensaje es monótono: el tiempo solo puede cerrar la ventana', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (a, b) => {
          const [pronto, tarde] = a <= b ? [a, b] : [b, a];
          const antes = decideSend(
            { lastInboundAt: hace(pronto), optedOut: false },
            AHORA,
          );
          const despues = decideSend(
            { lastInboundAt: hace(tarde), optedOut: false },
            AHORA,
          );
          if (antes.allowed && despues.allowed) {
            // Si la ventana estaba cerrada antes, no puede reabrirse.
            if (antes.kind === 'template')
              expect(despues.kind).toBe('template');
          }
        },
      ),
    );
  });
});
