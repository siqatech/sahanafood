'use client';

import { useActionState } from 'react';
import { emitirClave, revocarClave, type EstadoClave } from './acciones';

export function FormularioClave({
  marcas,
}: {
  marcas: Array<{ id: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoClave, FormData>(
    emitirClave,
    {},
  );

  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="cl-marca">Marca</label>
        <select id="cl-marca" name="brandId" defaultValue={marcas[0]?.id ?? ''}>
          {marcas.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      <div className="campo">
        <label htmlFor="cl-nombre">Para qué es</label>
        <input id="cl-nombre" name="label" placeholder="Mi web de WordPress" />
        <span className="tarjeta__pie">
          Con dos claves vivas, esto es lo que te dirá cuál revocar.
        </span>
      </div>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Creando…' : 'Crear clave'}
      </button>
      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
      {estado.ok ? <p className="tarjeta__pie">{estado.ok}</p> : null}
    </form>
  );
}

export function BotonRevocar({ id }: { id: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoClave, FormData>(
    revocarClave,
    {},
  );
  return (
    <form action={accion}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="secundario" disabled={pendiente}>
        Revocar
      </button>
      {estado.error ? <span className="baja">{estado.error}</span> : null}
    </form>
  );
}
