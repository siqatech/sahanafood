'use client';

import { useActionState, useRef } from 'react';
import type { RespuestaRapida } from '../../../lib/panel-api';
import { insertar } from './atajos';
import {
  responder,
  tomar,
  resolverConversacion,
  type EstadoBandeja,
} from './acciones';

/**
 * El compositor y las acciones del hilo (specs/ux/06).
 *
 * La decisión que gobierna esta pieza: **con la ventana cerrada no se deja
 * escribir texto libre**. Dejar pasar el texto y que Meta lo descarte en
 * silencio es el peor de los dos mundos — el agente cree que respondió y el
 * cliente no recibe nada (RN-CNV-03). Lo que sí queda habilitado es la nota
 * interna: apuntar algo para el turno siguiente no manda nada a nadie.
 */

function Resultado({ estado }: { estado: EstadoBandeja }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function Compositor({
  conversationId,
  puedeTextoLibre,
  etiquetaDeVentana,
  respuestas,
}: {
  conversationId: string;
  puedeTextoLibre: boolean;
  etiquetaDeVentana: string;
  respuestas: readonly RespuestaRapida[];
}) {
  const [estado, accion, pendiente] = useActionState<EstadoBandeja, FormData>(
    responder,
    {},
  );
  const caja = useRef<HTMLTextAreaElement>(null);

  /**
   * Pulsar una respuesta rápida la AÑADE al final de lo escrito.
   *
   * Se escribe sobre el campo con una referencia en vez de volverlo
   * controlado: el compositor lo vacía React al terminar la acción, y meterle
   * estado propio duplicaría esa lógica para ganar nada.
   */
  function pegar(cuerpo: string): void {
    const campo = caja.current;
    if (!campo) return;
    campo.value = insertar(campo.value, cuerpo);
    campo.focus();
    campo.setSelectionRange(campo.value.length, campo.value.length);
  }

  return (
    <form action={accion} className="compositor">
      <input type="hidden" name="conversationId" value={conversationId} />

      {!puedeTextoLibre ? (
        <p className="panel__error">
          {etiquetaDeVentana}. No se puede escribir texto libre: fuera de la
          ventana de 24 h el canal lo descarta sin avisar. Se puede dejar una
          nota interna, o usar una plantilla desde la API mientras la pantalla
          de plantillas no exista.
        </p>
      ) : null}

      <label htmlFor="texto">Mensaje</label>
      <textarea
        id="texto"
        name="text"
        ref={caja}
        rows={3}
        placeholder={
          puedeTextoLibre ? 'Escribe al cliente…' : 'Nota interna del turno…'
        }
      />

      {respuestas.length > 0 ? (
        <p className="atajos">
          <span className="tarjeta__rotulo">Respuestas rápidas</span>
          {respuestas.map((r) => (
            <button
              key={r.id}
              type="button"
              className="atajos__chip"
              onClick={() => pegar(r.body)}
              // El texto entero en el título: pegar a ciegas una plantilla que
              // no se recuerda es cómo se le manda a un cliente la política de
              // devolución cuando preguntaba por el horario.
              title={r.body}
            >
              /{r.shortcut}
            </button>
          ))}
        </p>
      ) : null}

      <p className="campo">
        <label>
          {/* Marcada sola cuando la ventana está cerrada: si lo único que se
              puede mandar es una nota, que el botón no engañe. */}
          <input
            type="checkbox"
            name="kind"
            value="note"
            defaultChecked={!puedeTextoLibre}
            disabled={!puedeTextoLibre}
          />{' '}
          Nota interna (no sale al cliente)
        </label>
      </p>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Enviando…' : 'Enviar'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function BotonTomar({
  conversationId,
  userId,
}: {
  conversationId: string;
  userId: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoBandeja, FormData>(
    tomar,
    {},
  );
  return (
    <>
      <form action={accion}>
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="userId" value={userId} />
        <button type="submit" disabled={pendiente}>
          {pendiente ? '…' : 'Tomar esta conversación'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

export function BotonResolver({ conversationId }: { conversationId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoBandeja, FormData>(
    resolverConversacion,
    {},
  );
  return (
    <>
      <form action={accion}>
        <input type="hidden" name="conversationId" value={conversationId} />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Marcar como resuelta'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}
