'use client';

import { useActionState, useState } from 'react';
import { ConfirmacionDestructiva } from '../confirmar';
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
  // Lo que se acababa de escribir. React vacía los campos no controlados al
  // terminar la acción, y ese vaciado llega DESPUÉS del mensaje de error: sin
  // esto, quien empieza a corregir el RUC en cuanto lee «son 11 dígitos» ve
  // desaparecer lo que está tecleando y vuelve a enviar el dato viejo.
  const v = estado.valores;

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
          defaultValue={v?.['docNumber'] ?? docNumber ?? ''}
        />
      </div>

      {tipo === 'RUC' ? (
        <div className="campo">
          <label htmlFor={`razon-${id}`}>Razón social</label>
          <input
            id={`razon-${id}`}
            name="legalName"
            defaultValue={v?.['legalName'] ?? legalName ?? ''}
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

/**
 * Anular un comprobante ya aceptado.
 *
 * Es LA acción irreversible del panel, y por eso es la que lleva la
 * confirmación destructiva de docs/25 en vez de un deshacer: emitir una nota de
 * crédito manda un documento nuevo al OSE y de ahí a SUNAT. No hay ocho
 * segundos de gracia que ofrecer — el documento ya salió.
 */
export function FormularioAnulacion({
  id,
  numero,
}: {
  id: string;
  numero: string;
}) {
  const [estado, accion, pendiente] = useActionState<
    EstadoComprobante,
    FormData
  >(anular, {});
  return (
    <>
      <form action={accion} className="en-linea">
        <ConfirmacionDestructiva
          titulo={`Anular ${numero}`}
          advertencia="Se emite una nota de crédito y se declara al OSE. No se puede deshacer: para revertirla habría que emitir otro comprobante."
          rotuloBoton="Nota de crédito"
          rotuloConfirmar="Emitir la nota de crédito"
          etiquetaMotivo="¿Por qué se anula?"
          pendiente={pendiente}
        >
          <input type="hidden" name="id" value={id} />
        </ConfirmacionDestructiva>
      </form>
      <Resultado estado={estado} />
    </>
  );
}
