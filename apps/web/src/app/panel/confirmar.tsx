'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * La confirmación destructiva (docs/25: «modal de confirmación destructiva
 * (escribir motivo, no solo "¿seguro?")»).
 *
 * ## Por qué escribir el motivo y no pulsar «sí»
 *
 * Un «¿seguro?» con un botón se contesta con el mismo dedo que provocó el error,
 * en el mismo segundo, sin leer. Escribir por qué obliga a parar y a formular la
 * intención — y ese medio segundo es toda la protección real que hay. Además el
 * motivo **queda**: una nota de crédito que dice «error de digitación en el RUC»
 * se explica sola dentro de tres meses ante SUNAT, y «anulado» no explica nada.
 *
 * ## Y por qué esto NO es lo mismo que el aviso con deshacer
 *
 * Los dos protegen del mismo dedo, pero se reparten el trabajo por si la acción
 * se puede revertir:
 *
 *  · **Reversible** —un precio, una pausa, una foto— va con deshacer. Confirmar
 *    veinte cambios de precio seguidos entrena a decir que sí sin mirar.
 *  · **Irreversible** —una nota de crédito ya declarada al OSE— va con esto.
 *    No hay «deshacer» que ofrecer: el documento ya salió.
 *
 * ## Sin JavaScript
 *
 * El panel funciona sin JS y esta pantalla no es la excepción: hasta que hidrata
 * se pinta el formulario de siempre, en línea, con su campo de motivo. Ya hoy
 * exige el motivo en el servidor, así que sin JS se pierde el diálogo, no la
 * protección. Al hidratar, el formulario se muda dentro de un `<dialog>` y el
 * botón pasa a abrirlo.
 */

export function ConfirmacionDestructiva({
  titulo,
  advertencia,
  rotuloBoton,
  rotuloConfirmar,
  etiquetaMotivo,
  nombreCampoMotivo = 'reason',
  minimoMotivo = 3,
  pendiente = false,
  children,
}: {
  titulo: string;
  /** Qué pasa exactamente, en una frase. Sin eufemismos. */
  advertencia: string;
  /** El botón que abre el diálogo, en la tabla. */
  rotuloBoton: string;
  /** El botón que ejecuta, dentro del diálogo. */
  rotuloConfirmar: string;
  etiquetaMotivo: string;
  nombreCampoMotivo?: string;
  minimoMotivo?: number;
  pendiente?: boolean;
  /** Los campos ocultos que identifican qué se destruye. */
  children?: React.ReactNode;
}) {
  const [hidratado, setHidratado] = useState(false);
  const [motivo, setMotivo] = useState('');
  const dialogo = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => setHidratado(true), []);

  // Cuando la acción termina, el diálogo tiene que cerrarse solo: dejarlo
  // abierto tapando la tabla haría dudar de si llegó a ejecutarse.
  useEffect(() => {
    if (!pendiente) dialogo.current?.close();
  }, [pendiente]);

  const motivoValido = motivo.trim().length >= minimoMotivo;

  if (!hidratado) {
    // Sin JS todavía: el formulario de siempre. El motivo sigue siendo
    // obligatorio — lo comprueba el servidor.
    return (
      <>
        {children}
        <input
          name={nombreCampoMotivo}
          placeholder={etiquetaMotivo}
          aria-label={etiquetaMotivo}
        />
        <button type="submit" className="discreto" disabled={pendiente}>
          {rotuloBoton}
        </button>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className="discreto peligroso"
        onClick={() => dialogo.current?.showModal()}
      >
        {rotuloBoton}
      </button>
      <dialog ref={dialogo} className="confirmar" aria-labelledby={`${id}-t`}>
        <h2 id={`${id}-t`} className="confirmar__titulo">
          {titulo}
        </h2>
        <p className="confirmar__advertencia">{advertencia}</p>
        {children}
        <div className="campo">
          <label htmlFor={`${id}-m`}>{etiquetaMotivo}</label>
          <textarea
            id={`${id}-m`}
            name={nombreCampoMotivo}
            rows={2}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            required
          />
          <p className="tarjeta__pie">
            Queda guardado con tu nombre y la hora. Es lo que se lee cuando
            alguien pregunte por qué.
          </p>
        </div>
        <div className="confirmar__botones">
          <button
            type="button"
            className="discreto"
            onClick={() => dialogo.current?.close()}
          >
            Cancelar
          </button>
          {/* Deshabilitado hasta que haya motivo: el «no» tiene que ser lo
              fácil, no un botón del mismo tamaño al lado del «sí». */}
          <button
            type="submit"
            className="peligroso"
            disabled={pendiente || !motivoValido}
          >
            {pendiente ? 'Ejecutando…' : rotuloConfirmar}
          </button>
        </div>
      </dialog>
    </>
  );
}
