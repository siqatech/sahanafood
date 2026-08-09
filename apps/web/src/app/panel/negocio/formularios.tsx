'use client';

import { useActionState } from 'react';
import { crearLocal, crearMarca, type EstadoNegocio } from './acciones';

function Resultado({ estado }: { estado: EstadoNegocio }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function FormularioMarca({ companyId }: { companyId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    crearMarca,
    {},
  );
  return (
    <form action={accion} className="ficha">
      <h2 style={{ marginTop: 0 }}>Añadir una marca</h2>
      <Resultado estado={estado} />
      <input type="hidden" name="companyId" value={companyId} />
      <div className="campo">
        <label htmlFor="marca-nombre">Nombre comercial</label>
        <input id="marca-nombre" name="name" required />
        <p className="tarjeta__pie">
          Es el nombre que ve el cliente. Varias marcas pueden producirse en la
          misma cocina: eso es una dark kitchen.
        </p>
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Creando…' : 'Crear marca'}
      </button>
    </form>
  );
}

export function FormularioLocal({ companyId }: { companyId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    crearLocal,
    {},
  );
  return (
    <form action={accion} className="ficha">
      <h2 style={{ marginTop: 0 }}>Añadir un local</h2>
      <Resultado estado={estado} />
      <input type="hidden" name="companyId" value={companyId} />
      <div className="campo">
        <label htmlFor="local-nombre">Nombre</label>
        <input id="local-nombre" name="name" required />
      </div>
      <div className="campo">
        <label htmlFor="local-direccion">Dirección</label>
        <input id="local-direccion" name="address" required />
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Creando…' : 'Crear local'}
      </button>
    </form>
  );
}
