// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TarjetaDeComanda } from './comanda';
import type { TicketDeCocina } from '../lib/api';

/**
 * Lo que el cocinero VE en la tarjeta (ADR-0021).
 *
 * La prueba que justificó el ADR es la primera: la banda de alérgenos. El dato
 * ya tenía pruebas en toda la cadena —se guarda al hacer el pedido, sobrevive a
 * un cambio de carta, llega al ticket de cocina y sale en el papel— y el `if`
 * que la pinta en la pantalla no lo comprobaba nada. Es el único aviso del
 * producto cuyo fallo no se mide en dinero.
 *
 * Las tres ramas del `if` son tres significados distintos y no dos:
 * hay alérgenos, no se registró (`null`, comandas anteriores a la migración
 * 0037) y se registró que no lleva ninguno (`[]`). Las dos últimas se pintan
 * igual —nada— por la misma razón: la pantalla no puede afirmar una inocuidad
 * que nadie declaró.
 */

const LINEA = {
  id: 'l-1',
  productName: 'Pollo a la brasa',
  quantity: 2,
  modifiersText: null,
  notes: null,
};

function ticket(
  linea: Partial<TicketDeCocina['lines'][number]> = {},
): TicketDeCocina {
  return {
    id: 't-1',
    orderId: 'o-1',
    orderNumber: 42,
    stationId: 's-1',
    stationName: 'Parrilla',
    brandId: 'b-1',
    brandName: 'Sahana Pollos',
    channel: 'web',
    status: 'queued',
    promisedAt: null,
    createdAt: '2026-08-26T12:00:00.000Z',
    waitingMinutes: 3,
    late: false,
    rowVersion: 1,
    lines: [{ ...LINEA, ...linea }],
  };
}

afterEach(() => {
  cleanup();
});

describe('banda de alérgenos', () => {
  it('se pinta cuando la línea trae alérgenos', () => {
    render(
      <TarjetaDeComanda
        ticket={ticket({ allergens: ['maní', 'lácteos'] })}
        avanzable
        onAvanzar={() => {}}
      />,
    );

    // Se buscan los nombres, no la clase CSS: lo que salva a alguien es leer
    // «maní», no que exista un div con el nombre correcto.
    expect(screen.getByText(/maní/)).toBeDefined();
    expect(screen.getByText(/lácteos/)).toBeDefined();
  });

  it('NO se pinta cuando no se registró (null)', () => {
    render(
      <TarjetaDeComanda
        ticket={ticket({ allergens: null })}
        avanzable
        onAvanzar={() => {}}
      />,
    );

    expect(document.querySelector('.comanda__alergenos')).toBeNull();
  });

  it('NO se pinta cuando se registró que no lleva ninguno (lista vacía)', () => {
    render(
      <TarjetaDeComanda
        ticket={ticket({ allergens: [] })}
        avanzable
        onAvanzar={() => {}}
      />,
    );

    expect(document.querySelector('.comanda__alergenos')).toBeNull();
  });

  it('NO se pinta en comandas sin el campo', () => {
    render(
      <TarjetaDeComanda ticket={ticket()} avanzable onAvanzar={() => {}} />,
    );

    expect(document.querySelector('.comanda__alergenos')).toBeNull();
  });
});

describe('el resto de la tarjeta', () => {
  it('enseña el número, la marca y el canal con su nombre escrito', () => {
    render(
      <TarjetaDeComanda ticket={ticket()} avanzable onAvanzar={() => {}} />,
    );

    expect(screen.getByText('#42')).toBeDefined();
    expect(screen.getByText('Sahana Pollos')).toBeDefined();
    // El canal NUNCA va solo en color: en una cocina oscura el color se
    // confunde y hay operarios que no lo distinguen.
    expect(screen.getByText(/web/i)).toBeDefined();
  });

  it('dice «origen desconocido» antes que dejar el canal en blanco', () => {
    render(
      <TarjetaDeComanda
        ticket={{ ...ticket(), channel: '' }}
        avanzable
        onAvanzar={() => {}}
      />,
    );

    expect(screen.getByText('origen desconocido')).toBeDefined();
  });

  it('enseña la nota de la línea', () => {
    render(
      <TarjetaDeComanda
        ticket={ticket({ notes: 'sin ají' })}
        avanzable
        onAvanzar={() => {}}
      />,
    );

    expect(screen.getByText('sin ají')).toBeDefined();
  });

  it('avanza al tocarla', () => {
    const onAvanzar = vi.fn();
    render(
      <TarjetaDeComanda ticket={ticket()} avanzable onAvanzar={onAvanzar} />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(onAvanzar).toHaveBeenCalledTimes(1);
    expect(onAvanzar.mock.calls[0]?.[0]).toMatchObject({ orderNumber: 42 });
  });

  it('no avanza desde la última columna', () => {
    const onAvanzar = vi.fn();
    render(
      <TarjetaDeComanda
        ticket={{ ...ticket(), status: 'ready' }}
        avanzable={false}
        onAvanzar={onAvanzar}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(onAvanzar).not.toHaveBeenCalled();
  });
});

describe('semáforo', () => {
  it('un ticket marcado tarde por el servidor va en rojo, calcule lo que calcule la tablet', () => {
    render(
      <TarjetaDeComanda
        ticket={{ ...ticket(), late: true }}
        avanzable
        onAvanzar={() => {}}
      />,
    );

    expect(screen.getByRole('button').className).toContain('comanda--rojo');
  });

  it('sin promesa no hay cuenta atrás: verde', () => {
    render(
      <TarjetaDeComanda ticket={ticket()} avanzable onAvanzar={() => {}} />,
    );

    expect(screen.getByRole('button').className).toContain('comanda--verde');
  });
});
