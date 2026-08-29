import { useState } from 'react';

/**
 * La checklist de una bolsa (ux/02 §Empaque, RN-KIT-03).
 *
 * Vive aparte de la pantalla, como la tarjeta de comanda y por lo mismo
 * (ADR-0021): lo que hay que poder comprobar es **que no se puede empacar sin
 * marcar todo**, y eso no necesita ni API ni reloj.
 *
 * Tres decisiones que no son de estilo:
 *
 *  · **El botón está deshabilitado hasta marcarlo todo.** El servidor también
 *    lo rechaza, pero un botón que se pulsa y da error enseña a pulsar dos
 *    veces. Aquí no hay nada que aprender: no se puede.
 *  · **No hay «marcar todas».** Es exactamente el atajo que anula el paso: si
 *    se puede marcar la bolsa entera sin mirarla, la verificación no verifica
 *    nada y el pedido incompleto sale igual.
 *  · **La línea entera es el objetivo táctil.** Se toca con una mano, con
 *    prisa, y a veces con guante.
 */

export interface LineaDeEmpaque {
  id: string;
  productName: string;
  quantity: number;
  modifiersText: string | null;
  notes: string | null;
}

export function ChecklistDeEmpaque({
  lineas,
  onEmpacar,
}: {
  lineas: LineaDeEmpaque[];
  onEmpacar: (marcadas: string[]) => void;
}) {
  const [marcadas, setMarcadas] = useState<string[]>([]);
  const faltan = lineas.length - marcadas.length;

  function alternar(id: string): void {
    setMarcadas((previas) =>
      previas.includes(id) ? previas.filter((x) => x !== id) : [...previas, id],
    );
  }

  return (
    <>
      <ul className="empaque__lineas">
        {lineas.map((l) => {
          const marcada = marcadas.includes(l.id);
          return (
            <li key={l.id}>
              <button
                type="button"
                className={`empaque__linea${marcada ? ' empaque__linea--ok' : ''}`}
                aria-pressed={marcada}
                onClick={() => {
                  alternar(l.id);
                }}
              >
                <span className="empaque__marca-visual" aria-hidden="true">
                  {marcada ? '✓' : ''}
                </span>
                <span>
                  <strong>{l.quantity}×</strong> {l.productName}
                  {l.modifiersText ? (
                    <div className="comanda__modificadores">
                      {l.modifiersText}
                    </div>
                  ) : null}
                  {l.notes ? (
                    <div className="comanda__nota">{l.notes}</div>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="empaque__boton"
        disabled={faltan > 0}
        onClick={() => {
          onEmpacar(marcadas);
        }}
      >
        {faltan > 0
          ? `Faltan ${faltan} por verificar`
          : 'Empacado — imprimir etiqueta'}
      </button>
    </>
  );
}
