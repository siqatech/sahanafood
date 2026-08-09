'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  aceptar,
  rechazar,
  reintentar,
  type EstadoOperaciones,
} from './acciones';

/**
 * Las piezas vivas de la torre de control (specs/ux/05).
 *
 * Son de cliente por una razón que no es estética: **el reloj**. Un plazo
 * pintado en el servidor se congela en la página y miente en cuanto pasa un
 * minuto — y aquí lo que se mira es precisamente cuánto queda antes de que el
 * sistema rechace el pedido solo. Un contador equivocado en esta pantalla es un
 * pedido perdido.
 */

function Resultado({ estado }: { estado: EstadoOperaciones }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

/** Reloj de cuenta atrás hasta `limite`, en mm:ss. */
export function Cuenta({ limite }: { limite: string }) {
  const objetivo = Date.parse(limite);
  const [restante, setRestante] = useState(() => objetivo - Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setRestante(objetivo - Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [objetivo]);

  const segundos = Math.max(0, Math.floor(restante / 1000));
  const mm = String(Math.floor(segundos / 60)).padStart(2, '0');
  const ss = String(segundos % 60).padStart(2, '0');

  // Tres estados y no dos: «va bien», «queda poco» y «se acabó». El último no
  // es rojo intenso por gusto — a partir de ahí el barrido ya puede haberlo
  // rechazado, y decir «00:00» sin más haría creer que aún se llega.
  const nivel = segundos === 0 ? 'vencido' : segundos <= 120 ? 'poco' : 'ok';

  return (
    <span className={`cuenta cuenta--${nivel}`}>
      {/* Texto además del color: en una pantalla de mostrador con luz directa
          el ámbar y el rojo se confunden (docs/25 §6). */}
      {segundos === 0 ? 'plazo vencido' : `quedan ${mm}:${ss}`}
    </span>
  );
}

export function BotonesDeAceptacion({ orderId }: { orderId: string }) {
  const [estadoA, accionAceptar, aceptando] = useActionState<
    EstadoOperaciones,
    FormData
  >(aceptar, {});
  const [estadoR, accionRechazar, rechazando] = useActionState<
    EstadoOperaciones,
    FormData
  >(rechazar, {});

  return (
    <>
      <form action={accionAceptar}>
        <input type="hidden" name="orderId" value={orderId} />
        <button type="submit" className="grande" disabled={aceptando}>
          {aceptando ? 'Aceptando…' : 'Aceptar'}
        </button>
      </form>
      <Resultado estado={estadoA} />

      <form action={accionRechazar} className="en-linea">
        <input type="hidden" name="orderId" value={orderId} />
        <input
          name="reason"
          placeholder="Motivo"
          aria-label={`Motivo del rechazo del pedido ${orderId}`}
        />
        <button type="submit" className="discreto" disabled={rechazando}>
          {rechazando ? '…' : 'Rechazar'}
        </button>
      </form>
      <Resultado estado={estadoR} />
    </>
  );
}

export function BotonReintentar({ id }: { id: string }) {
  const [estado, accion, pendiente] = useActionState<
    EstadoOperaciones,
    FormData
  >(reintentar, {});
  return (
    <>
      <form action={accion}>
        <input type="hidden" name="id" value={id} />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Reintentar'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

/**
 * Recarga la pantalla cada `segundos`.
 *
 * La torre de control se deja abierta en una pantalla del local. Sin esto,
 * enseñaría la foto del momento en que alguien la abrió — y un pedido que entró
 * hace ocho minutos no aparecería hasta que a alguien se le ocurriera pulsar
 * F5, que es justo lo que esta pantalla existe para evitar.
 */
export function Refresco({ segundos }: { segundos: number }) {
  useEffect(() => {
    const id = setInterval(() => {
      window.location.reload();
    }, segundos * 1000);
    return () => {
      clearInterval(id);
    };
  }, [segundos]);
  return null;
}
