import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { windowCountdown, CLOSING_SOON_MINUTES } from './window-countdown.js';

const AHORA = new Date('2026-06-15T20:00:00Z');
const haceHoras = (h: number): Date =>
  new Date(AHORA.getTime() - h * 3_600_000);

const contacto = (lastInboundAt: Date | null) => ({
  lastInboundAt,
  optedOut: false,
});

describe('Cuenta regresiva de la ventana de 24 h (RN-CNV-03, T5.20)', () => {
  it('recién escrito: abierta, casi 24 h', () => {
    const c = windowCountdown(contacto(haceHoras(0)), AHORA);
    expect(c.state).toBe('open');
    expect(c.canSendFreeform).toBe(true);
    expect(c.minutesRemaining).toBe(24 * 60);
    expect(c.label).toContain('24 h');
  });

  it('a falta de una hora AVISA, pero deja escribir', () => {
    // Una hora y no diez minutos: el agente tiene que poder terminar la
    // conversación, no enterarse cuando ya no llega.
    const c = windowCountdown(contacto(haceHoras(23.5)), AHORA);
    expect(c.state).toBe('closing');
    expect(c.canSendFreeform).toBe(true);
    expect(c.minutesRemaining).toBe(30);
    expect(c.label).toContain('30 min');
  });

  it('EXPIRADA: no deja escribir libre, y lo dice', () => {
    // La regla entera de RN-CNV-03. Dejar escribir y que Meta lo descarte en
    // silencio es el peor de los dos mundos: el agente cree que contestó y el
    // cliente no recibe nada.
    const c = windowCountdown(contacto(haceHoras(25)), AHORA);
    expect(c.state).toBe('expired');
    expect(c.canSendFreeform).toBe(false);
    expect(c.minutesRemaining).toBe(0);
    expect(c.label).toContain('plantilla aprobada');
  });

  it('justo en el límite está cerrada', () => {
    const c = windowCountdown(contacto(haceHoras(24)), AHORA);
    expect(c.state).toBe('expired');
    expect(c.canSendFreeform).toBe(false);
  });

  it('un contacto que nunca escribió no tiene ventana', () => {
    const c = windowCountdown(contacto(null), AHORA);
    expect(c.state).toBe('never_opened');
    expect(c.canSendFreeform).toBe(false);
    expect(c.expiresAt).toBeNull();
    expect(c.label).toContain('plantilla');
  });

  it('redondea hacia ARRIBA: con 30 s quedan 1 min, no 0', () => {
    // Con redondeo hacia abajo diría «0 min» cuando todavía se puede escribir,
    // y el agente dejaría de intentarlo antes de tiempo.
    const c = windowCountdown(
      contacto(new Date(AHORA.getTime() - 24 * 3_600_000 + 30_000)),
      AHORA,
    );
    expect(c.minutesRemaining).toBe(1);
    expect(c.canSendFreeform).toBe(true);
  });

  it('PROPIEDAD: canSendFreeform ⟺ queda tiempo', () => {
    fc.assert(
      fc.property(fc.integer({ min: -600, max: 2000 }), (minutosDesde) => {
        const c = windowCountdown(
          contacto(new Date(AHORA.getTime() - minutosDesde * 60_000)),
          AHORA,
        );
        // La invariante que importa: no hay ningún estado en el que se pueda
        // escribir libre con la ventana vencida.
        expect(c.canSendFreeform).toBe(c.minutesRemaining > 0);
        if (c.canSendFreeform) {
          expect(c.expiresAt!.getTime()).toBeGreaterThan(AHORA.getTime());
        }
        // Y el aviso aparece siempre por debajo del umbral.
        if (
          c.minutesRemaining > 0 &&
          c.minutesRemaining <= CLOSING_SOON_MINUTES
        ) {
          expect(c.state).toBe('closing');
        }
      }),
      { numRuns: 400 },
    );
  });
});
