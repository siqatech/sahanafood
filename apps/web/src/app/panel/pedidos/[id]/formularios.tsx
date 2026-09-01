'use client';

import { useActionState } from 'react';
import {
  pedirDevolucion,
  crearEnlaceDePago,
  type EstadoDevolucion,
} from './acciones';

/**
 * Pedir una devolución (RN-PAY-03).
 *
 * Los campos de la segunda firma se enseñan SIEMPRE, no solo cuando la API se
 * queja: quien va a devolver un importe grande ya sabe que necesita a alguien
 * al lado, y enterarse después de rellenar el motivo es peor que saberlo antes.
 */
export function FormularioDevolucion({
  intentId,
  orderId,
  importe,
  aprobadores,
}: {
  intentId: string;
  orderId: string;
  importe: string;
  aprobadores: Array<{ id: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<
    EstadoDevolucion,
    FormData
  >(pedirDevolucion, {});

  return (
    <form action={accion}>
      <input type="hidden" name="intentId" value={intentId} />
      <input type="hidden" name="orderId" value={orderId} />

      <div className="campo">
        <label htmlFor={`motivo-${intentId}`}>Por qué se devuelve</label>
        <input
          id={`motivo-${intentId}`}
          name="reason"
          placeholder="El pedido se canceló y ya estaba cobrado"
        />
        <span className="tarjeta__pie">
          Lo lee quien audite la devolución, y es lo que se le explica al
          cliente.
        </span>
      </div>

      <div className="campo">
        <label htmlFor={`aprueba-${intentId}`}>Quién aprueba</label>
        <select id={`aprueba-${intentId}`} name="approvedBy" defaultValue="">
          <option value="">— no hace falta (importe pequeño) —</option>
          {aprobadores.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="tarjeta__pie">
          Por encima del umbral hacen falta dos personas, y quien firma necesita
          permiso para devolver dinero: no basta con tener un PIN.
        </span>
      </div>

      <div className="campo">
        <label htmlFor={`pin-${intentId}`}>Su PIN</label>
        <input
          id={`pin-${intentId}`}
          name="approverPin"
          className="corto"
          type="password"
          inputMode="numeric"
          autoComplete="off"
        />
        <span className="tarjeta__pie">
          Lo teclea esa persona, aquí y ahora. Un nombre en una lista no aprueba
          nada: lo escribe quien pide.
        </span>
      </div>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Pidiendo…' : `Devolver S/ ${importe}`}
      </button>

      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
      {estado.ok ? <p className="tarjeta__pie">{estado.ok}</p> : null}
    </form>
  );
}

/**
 * Emitir el enlace de pago y dejarlo listo para copiar.
 *
 * La pasarela va en el formulario y no se adivina: un negocio puede tener más
 * de una conectada —una por marca— y cobrar por la que no toca manda el dinero
 * a la cuenta equivocada.
 */
export function BotonEnlaceDePago({
  orderId,
  pasarelas,
}: {
  orderId: string;
  pasarelas: Array<{ id: string; provider: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<
    EstadoDevolucion,
    FormData
  >(crearEnlaceDePago, {});

  if (pasarelas.length === 0) {
    return (
      <p className="tarjeta__pie">
        No hay ninguna pasarela conectada, así que no se puede cobrar por
        enlace. Se conecta en <a href="/panel/pagos">Pagos</a>.
      </p>
    );
  }

  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="orderId" value={orderId} />
        {/* El origen sale del navegador porque el panel de cada cliente vive
            en SU dominio. Sin JavaScript se queda vacío y la acción devuelve
            la ruta relativa, que sigue sirviendo para pegarla a mano. */}
        <input
          type="hidden"
          name="origen"
          value={typeof window === 'undefined' ? '' : window.location.origin}
        />
        {pasarelas.length === 1 ? (
          <input type="hidden" name="provider" value={pasarelas[0]!.provider} />
        ) : (
          <select
            name="provider"
            aria-label="Con qué pasarela se cobra"
            defaultValue={pasarelas[0]!.provider}
          >
            {pasarelas.map((p) => (
              <option key={p.id} value={p.provider}>
                {p.provider}
              </option>
            ))}
          </select>
        )}
        <button type="submit" disabled={pendiente}>
          {pendiente ? 'Emitiendo…' : 'Cobrar por enlace'}
        </button>
      </form>
      {estado.ok ? (
        <>
          <input
            className="enlace-copiable"
            type="text"
            readOnly
            value={estado.ok}
            aria-label="Enlace de pago"
            onFocus={(e) => e.currentTarget.select()}
          />
          <p className="tarjeta__pie">
            Mándaselo al cliente. Caduca, y quien lo tenga puede pagar: no lo
            publiques donde lo vea alguien más.
          </p>
        </>
      ) : null}
      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
    </>
  );
}
