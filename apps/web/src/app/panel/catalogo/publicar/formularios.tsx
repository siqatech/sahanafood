'use client';

import { useActionState } from 'react';
import { publicar, type EstadoPublicacion } from './acciones';

/**
 * Publicar la carta de un canal (T4.06).
 *
 * La nota es opcional pero se pide: dentro de un mes, «versión 7» no dice nada
 * y «subida de precios de enero» sí. Es lo único que convierte el historial en
 * algo que se pueda leer.
 */
export function FormularioPublicar({
  brandId,
  channel,
}: {
  brandId: string;
  channel: string;
}) {
  const [estado, accion, pendiente] = useActionState<
    EstadoPublicacion,
    FormData
  >(publicar, {});

  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="brandId" value={brandId} />
        <input type="hidden" name="channel" value={channel} />
        <input
          name="notes"
          placeholder="Qué cambia (opcional)"
          aria-label={`Nota de la publicación de ${channel}`}
          maxLength={500}
        />
        <button type="submit" disabled={pendiente}>
          {pendiente ? 'Publicando…' : `Publicar ${channel}`}
        </button>
      </form>
      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
      {estado.ok ? <p className="tarjeta__pie">{estado.ok}</p> : null}
    </>
  );
}
