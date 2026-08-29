// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ChecklistDeEmpaque, type LineaDeEmpaque } from './empaque-tarjeta';

/** `disabled` se lee del DOM y no con `toBeDisabled`: el ADR-0021 dejó fuera
 *  `jest-dom` a propósito, y una aserción de una línea no justifica añadirlo. */
function bloqueado(boton: HTMLElement): boolean {
  return (boton as HTMLButtonElement).disabled;
}

/**
 * La checklist de empaque (RN-KIT-03).
 *
 * Lo que se defiende es UNA cosa: **que no se pueda empacar sin haber marcado
 * todas las líneas**. Mandar el pedido incompleto cuesta el pedido, el reparto
 * y el cliente, y es el fallo más frecuente del delivery.
 *
 * El servidor también lo rechaza —tiene su prueba—, pero un botón que se pulsa
 * y da error enseña a pulsar dos veces. Aquí no hay nada que aprender.
 */

const LINEAS: LineaDeEmpaque[] = [
  {
    id: 'l-1',
    productName: 'Pollo a la brasa',
    quantity: 1,
    modifiersText: 'Grande',
    notes: null,
  },
  {
    id: 'l-2',
    productName: 'Chicha morada',
    quantity: 2,
    modifiersText: null,
    notes: 'sin azúcar',
  },
];

afterEach(() => {
  cleanup();
});

describe('ChecklistDeEmpaque', () => {
  it('no deja empacar hasta que TODAS las líneas están marcadas', () => {
    const onEmpacar = vi.fn();
    render(<ChecklistDeEmpaque lineas={LINEAS} onEmpacar={onEmpacar} />);

    const empacar = screen.getByRole('button', { name: /Faltan 2/ });
    expect(bloqueado(empacar)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Pollo a la brasa/ }));
    expect(bloqueado(screen.getByRole('button', { name: /Faltan 1/ }))).toBe(
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: /Chicha morada/ }));
    const listo = screen.getByRole('button', { name: /Empacado/ });
    expect(bloqueado(listo)).toBe(false);

    fireEvent.click(listo);
    expect(onEmpacar).toHaveBeenCalledTimes(1);
    expect(onEmpacar.mock.calls[0]?.[0]).toEqual(['l-1', 'l-2']);
  });

  it('desmarcar vuelve a bloquear: un toque de más no da la bolsa por buena', () => {
    render(<ChecklistDeEmpaque lineas={LINEAS} onEmpacar={() => {}} />);

    const pollo = screen.getByRole('button', { name: /Pollo a la brasa/ });
    fireEvent.click(pollo);
    fireEvent.click(screen.getByRole('button', { name: /Chicha morada/ }));
    expect(bloqueado(screen.getByRole('button', { name: /Empacado/ }))).toBe(
      false,
    );

    fireEvent.click(pollo);
    expect(bloqueado(screen.getByRole('button', { name: /Faltan 1/ }))).toBe(
      true,
    );
  });

  it('la línea marcada lo dice, no solo lo colorea', () => {
    // En una cocina con vapor y luz de sodio el color solo no se distingue
    // (docs/25 §6). `aria-pressed` es además lo que lee un lector de pantalla.
    render(<ChecklistDeEmpaque lineas={LINEAS} onEmpacar={() => {}} />);
    const pollo = screen.getByRole('button', { name: /Pollo a la brasa/ });

    expect(pollo.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pollo);
    expect(pollo.getAttribute('aria-pressed')).toBe('true');
    expect(pollo.textContent).toContain('✓');
  });

  it('NO hay «marcar todas»: ese atajo anula el paso entero', () => {
    // Si se puede dar la bolsa entera por buena sin mirarla, la verificación no
    // verifica nada y el pedido incompleto sale igual.
    render(<ChecklistDeEmpaque lineas={LINEAS} onEmpacar={() => {}} />);
    const botones = screen
      .getAllByRole('button')
      .map((b) => (b.textContent ?? '').toLowerCase());
    expect(botones.some((t) => t.includes('todas') || t.includes('todo'))).toBe(
      false,
    );
  });

  it('enseña los modificadores y la nota: la bolsa se comprueba contra ellos', () => {
    render(<ChecklistDeEmpaque lineas={LINEAS} onEmpacar={() => {}} />);
    expect(screen.getByText('Grande')).toBeDefined();
    expect(screen.getByText('sin azúcar')).toBeDefined();
  });
});
