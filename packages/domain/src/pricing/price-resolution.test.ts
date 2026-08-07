import { describe, it, expect } from 'vitest';
import {
  resolvePrice,
  isSellableInChannel,
  isPaused,
  isAvailable,
  type ScopedPrice,
  type ProductPause,
} from './price-resolution.js';

const precio = (
  priceMinor: number,
  channel: string | null,
  locationId: string | null = null,
  active = true,
): ScopedPrice => ({ priceMinor, channel, locationId, active });

const BASE = precio(300_000, null); // S/ 30 base
const WEB = precio(320_000, 'web'); // S/ 32 en web
const WEB_LOCAL = precio(350_000, 'web', 'loc-1'); // S/ 35 en web del local 1

describe('resolvePrice — prioridad de ámbito (RN-CAT-01)', () => {
  it('usa el precio base cuando no hay nada más específico', () => {
    const r = resolvePrice([BASE], { channel: 'web' });
    expect(r?.priceMinor).toBe(300_000);
  });

  it('el precio de canal gana al base', () => {
    const r = resolvePrice([BASE, WEB], { channel: 'web' });
    expect(r?.priceMinor).toBe(320_000);
  });

  it('el precio de (canal, local) gana a los dos anteriores', () => {
    const r = resolvePrice([BASE, WEB, WEB_LOCAL], {
      channel: 'web',
      locationId: 'loc-1',
    });
    expect(r?.priceMinor).toBe(350_000);
  });

  it('el precio de otro local no se aplica: cae al de canal', () => {
    const r = resolvePrice([BASE, WEB, WEB_LOCAL], {
      channel: 'web',
      locationId: 'loc-2',
    });
    expect(r?.priceMinor).toBe(320_000);
  });

  it('un canal sin precio propio cae al base', () => {
    const r = resolvePrice([BASE, WEB], { channel: 'pos' });
    expect(r?.priceMinor).toBe(300_000);
  });

  it('el orden de la lista no altera el resultado', () => {
    const query = { channel: 'web', locationId: 'loc-1' };
    const a = resolvePrice([BASE, WEB, WEB_LOCAL], query);
    const b = resolvePrice([WEB_LOCAL, BASE, WEB], query);
    const c = resolvePrice([WEB, WEB_LOCAL, BASE], query);
    expect(a?.priceMinor).toBe(350_000);
    expect(b?.priceMinor).toBe(350_000);
    expect(c?.priceMinor).toBe(350_000);
  });

  it('SIN PRECIO PARA EL CANAL, el producto no se vende ahí', () => {
    // Solo hay precio de web; se pregunta por rappi y no hay base.
    const r = resolvePrice([WEB], { channel: 'rappi' });
    expect(r).toBeUndefined();
    expect(isSellableInChannel([WEB], { channel: 'rappi' })).toBe(false);
    // Pero en web sí.
    expect(isSellableInChannel([WEB], { channel: 'web' })).toBe(true);
  });

  it('sin precios en absoluto, no es vendible', () => {
    expect(resolvePrice([], { channel: 'web' })).toBeUndefined();
  });

  it('ignora precios desactivados', () => {
    const r = resolvePrice([BASE, precio(999_000, 'web', null, false)], {
      channel: 'web',
    });
    expect(r?.priceMinor).toBe(300_000);
  });

  it('ante empate de especificidad elige el MENOR precio, de forma determinista', () => {
    // Datos incoherentes (violarían el índice único): se resuelve a favor del cliente.
    const a = precio(400_000, 'web');
    const b = precio(350_000, 'web');
    expect(resolvePrice([a, b], { channel: 'web' })?.priceMinor).toBe(350_000);
    expect(resolvePrice([b, a], { channel: 'web' })?.priceMinor).toBe(350_000);
  });

  it('un precio con local no aplica si la consulta no trae local', () => {
    const r = resolvePrice([WEB_LOCAL], { channel: 'web' });
    expect(r).toBeUndefined();
  });

  it('el precio puede ser cero (producto de regalo)', () => {
    const r = resolvePrice([precio(0, 'pos')], { channel: 'pos' });
    expect(r?.priceMinor).toBe(0);
    expect(isSellableInChannel([precio(0, 'pos')], { channel: 'pos' })).toBe(
      true,
    );
  });
});

describe('isPaused — pausa de producto (RN-CAT-03)', () => {
  const ahora = new Date('2026-08-11T18:00:00Z');
  const pausa = (channel: string, until: Date | null): ProductPause => ({
    channel,
    until,
  });

  it('una pausa sin caducidad sigue activa', () => {
    expect(isPaused([pausa('web', null)], 'web', ahora)).toBe(true);
  });

  it('una pausa con caducidad futura sigue activa', () => {
    expect(
      isPaused([pausa('web', new Date('2026-08-11T20:00:00Z'))], 'web', ahora),
    ).toBe(true);
  });

  it('UNA PAUSA CADUCADA SE AUTOLEVANTA', () => {
    // Nadie tiene que acordarse de reactivar el producto en hora punta.
    expect(
      isPaused([pausa('web', new Date('2026-08-11T17:00:00Z'))], 'web', ahora),
    ).toBe(false);
  });

  it('la pausa de un canal no afecta a otro', () => {
    expect(isPaused([pausa('web', null)], 'pos', ahora)).toBe(false);
  });

  it('la pausa comodín afecta a todos los canales', () => {
    expect(isPaused([pausa('*', null)], 'pos', ahora)).toBe(true);
    expect(isPaused([pausa('*', null)], 'rappi', ahora)).toBe(true);
  });

  it('sin pausas no está pausado', () => {
    expect(isPaused([], 'web', ahora)).toBe(false);
  });
});

describe('isAvailable — precio resuelto y sin pausa', () => {
  const ahora = new Date('2026-08-11T18:00:00Z');

  it('disponible con precio y sin pausa', () => {
    expect(isAvailable([BASE], [], { channel: 'web' }, ahora)).toBe(true);
  });

  it('no disponible si está pausado, aunque tenga precio', () => {
    expect(
      isAvailable(
        [BASE],
        [{ channel: 'web', until: null }],
        { channel: 'web' },
        ahora,
      ),
    ).toBe(false);
  });

  it('no disponible sin precio para el canal, aunque no esté pausado', () => {
    expect(isAvailable([WEB], [], { channel: 'rappi' }, ahora)).toBe(false);
  });

  it('vuelve a estar disponible al caducar la pausa', () => {
    const pausas = [
      { channel: 'web', until: new Date('2026-08-11T17:00:00Z') },
    ];
    expect(isAvailable([BASE], pausas, { channel: 'web' }, ahora)).toBe(true);
  });
});
