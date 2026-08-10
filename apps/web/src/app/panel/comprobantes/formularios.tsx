'use client';

import { useActionState, useState } from 'react';
import { corregir, reenviar, anular, type EstadoComprobante } from './acciones';

/** Las tres acciones de la cola de corrección (RN-BIL-02). */

function Resultado({ estado }: { estado: EstadoComprobante }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function FormularioCorreccion({
  id,
  docType,
  docNumber,
  legalName,
}: {
  id: string;
  docType: string;
  docNumber: string | null;
  legalName: string | null;
}) {
  const [estado, accion, pendiente] = useActionState<
    EstadoComprobante,
    FormData
  >(corregir, {});
  // El tipo manda sobre lo que hay que rellenar: una factura necesita razón
  // social y una boleta no, y pedirla siempre entrena a la gente a inventarla.
  const [tipo, setTipo] = useState(docType);

  return (
    <form action={accion} className="correccion">
      <input type="hidden" name="id" value={id} />

      <div className="campo">
        <label htmlFor={`tipo-${id}`}>Documento del cliente</label>
        <select
          id={`tipo-${id}`}
          name="docType"
          value={tipo}
          onChange={(e) => setTipo(e.target.value)}
        >
          <option value="RUC">RUC</option>
          <option value="DNI">DNI</option>
          <option value="CE">Carné de extranjería</option>
          <option value="PASAPORTE">Pasaporte</option>
        </select>
      </div>

      <div className="campo">
        <label htmlFor={`num-${id}`}>Número</label>
        <input
          id={`num-${id}`}
          name="docNumber"
          className="corto"
          inputMode="numeric"
          defaultValue={docNumber ?? ''}
        />
      </div>

      {tipo === 'RUC' ? (
        <div className="campo">
          <label htmlFor={`razon-${id}`}>Razón social</label>
          <input
            id={`razon-${id}`}
            name="legalName"
            defaultValue={legalName ?? ''}
          />
        </div>
      ) : null}

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Reenviando…' : 'Corregir y reenviar'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function BotonReenviar({ id }: { id: string }) {
  const [estado, accion, pendiente] = useActionState<
    EstadoComprobante,
    FormData
  >(reenviar, {});
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="id" value={id} />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? 'Enviando…' : 'Reenviar sin cambios'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

export function FormularioAnulacion({ id }: { id: string }) {
  const [estado, accion, pendiente] = useActionState<
    EstadoComprobante,
    FormData
  >(anular, {});
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="id" value={id} />
        <input
          name="reason"
          placeholder="Motivo de la anulación"
          aria-label={`Motivo de anulación de ${id}`}
        />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Nota de crédito'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}
