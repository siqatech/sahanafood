'use client';

import { useActionState } from 'react';
import {
  crearUsuario,
  cambiarRol,
  cambiarEstado,
  type EstadoEquipo,
} from './acciones';

/** Los formularios del equipo (specs/ux/03 → Configuración/usuarios). */

function Resultado({ estado }: { estado: EstadoEquipo }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function FormularioAlta({
  roles,
}: {
  roles: Array<{ code: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoEquipo, FormData>(
    crearUsuario,
    {},
  );
  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="eq-nombre">Nombre</label>
        <input id="eq-nombre" name="fullName" placeholder="Rosa Quispe" />
      </div>
      <div className="campo">
        <label htmlFor="eq-email">Correo</label>
        <input id="eq-email" name="email" type="email" />
      </div>
      <div className="campo">
        <label htmlFor="eq-rol">Rol</label>
        {/* Los roles vienen del servidor: son los mismos que comprueba el
            guardia, y una lista escrita aquí se desviaría al añadir uno. */}
        <select id="eq-rol" name="roleCode" defaultValue="">
          <option value="">— elige el rol —</option>
          {roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div className="campo">
        <label htmlFor="eq-pass">Contraseña</label>
        <input id="eq-pass" name="password" type="password" />
        <span className="tarjeta__pie">
          Mínimo 12 caracteres. Se la entregas en persona: todavía no hay
          invitación por correo, y decirlo es mejor que fingir que la hay.
        </span>
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Dando de alta…' : 'Dar de alta'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function SelectorDeRol({
  userId,
  actual,
  roles,
}: {
  userId: string;
  actual: string;
  roles: Array<{ code: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoEquipo, FormData>(
    cambiarRol,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="userId" value={userId} />
        <select
          name="roleCode"
          defaultValue={actual}
          aria-label={`Rol de ${userId}`}
        >
          {roles.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Cambiar'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

export function BotonEstado({
  userId,
  activo,
}: {
  userId: string;
  activo: boolean;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoEquipo, FormData>(
    cambiarEstado,
    {},
  );
  return (
    <>
      <form action={accion}>
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="active" value={activo ? 'false' : 'true'} />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : activo ? 'Desactivar' : 'Reactivar'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}
