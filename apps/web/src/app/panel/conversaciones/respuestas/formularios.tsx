'use client';

import { useActionState } from 'react';
import {
  crearRespuestaRapida,
  borrarRespuestaRapida,
  type EstadoBandeja,
} from '../acciones';

function Resultado({ estado }: { estado: EstadoBandeja }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function FormularioRespuesta({
  marcas,
}: {
  marcas: Array<{ id: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoBandeja, FormData>(
    crearRespuestaRapida,
    {},
  );

  return (
    <form action={accion} className="ficha">
      <p className="campo">
        <label htmlFor="shortcut">Atajo</label>
        <input
          id="shortcut"
          name="shortcut"
          placeholder="/recojo"
          defaultValue={estado.valores?.['shortcut'] ?? ''}
          required
        />
        <span className="tarjeta__pie">
          Sin espacios. En la bandeja se escribe con barra delante y el texto
          aparece solo.
        </span>
      </p>

      <p className="campo">
        <label htmlFor="body">Qué se manda</label>
        <textarea
          id="body"
          name="body"
          rows={3}
          placeholder="Puedes recogerlo en Av. Pardo 123, Miraflores."
          defaultValue={estado.valores?.['body'] ?? ''}
          required
        />
      </p>

      <p className="campo">
        <label htmlFor="brandId">Marca</label>
        <select id="brandId" name="brandId" defaultValue="">
          {/* Por defecto vale para todas: es lo correcto en un «gracias, ya lo
              anoto». Una dirección de recojo NO —cada marca tiene la suya—, y
              por eso la opción de marca está aquí y no escondida. */}
          <option value="">Todas las marcas</option>
          {marcas.map((m) => (
            <option key={m.id} value={m.id}>
              Solo {m.name}
            </option>
          ))}
        </select>
      </p>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Guardando…' : 'Guardar respuesta'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function BotonBorrar({ id, atajo }: { id: string; atajo: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoBandeja, FormData>(
    borrarRespuestaRapida,
    {},
  );

  return (
    <form action={accion}>
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="secundario"
        disabled={pendiente}
        aria-label={`Borrar la respuesta ${atajo}`}
      >
        {pendiente ? 'Borrando…' : 'Borrar'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}
