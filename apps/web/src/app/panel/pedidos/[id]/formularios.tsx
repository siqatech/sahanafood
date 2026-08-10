'use client';

import { useActionState } from 'react';
import { pedirDevolucion, type EstadoDevolucion } from './acciones';

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
