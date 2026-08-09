'use client';

import { useActionState } from 'react';
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
}: {
  conversationId: string;
  puedeTextoLibre: boolean;
  etiquetaDeVentana: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoBandeja, FormData>(
    responder,
    {},
  );

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
        rows={3}
        placeholder={
          puedeTextoLibre ? 'Escribe al cliente…' : 'Nota interna del turno…'
        }
      />

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
