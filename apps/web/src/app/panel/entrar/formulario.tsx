'use client';

import { useActionState } from 'react';
import { entrar, type EstadoAcceso } from './acciones';

/**
 * Pantalla de acceso.
 *
 * El único componente de cliente del panel, y solo para enseñar el error sin
 * recargar. Funciona igual con JavaScript desactivado: es un `<form>` que
 * postea.
 */
export function FormularioDeAcceso({
  destino,
  caducada,
}: {
  destino: string;
  caducada: boolean;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoAcceso, FormData>(
    entrar,
    {},
  );

  return (
    <form action={accion} className="acceso">
      <h1>Entrar al panel</h1>
      {caducada && !estado.error ? (
        <p className="panel__error">
          Tu sesión caducó por inactividad. Vuelve a entrar y sigues donde
          estabas.
        </p>
      ) : null}
      {estado.error ? <p className="panel__error">{estado.error}</p> : null}

      <input type="hidden" name="destino" value={destino} />

      <div className="campo">
        <label htmlFor="email">Correo</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
        />
      </div>
      <div className="campo">
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
