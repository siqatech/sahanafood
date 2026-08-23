'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { ConfirmacionDestructiva } from '../confirmar';
import { anonimizar, type EstadoCliente } from './acciones';

/**
 * Anonimizar a solicitud (RN-CRM-02).
 *
 * Va con la confirmación destructiva de docs/25 porque es **irreversible**: no
 * hay «deshacer», y si lo hubiera el dato no estaría anonimizado, estaría
 * escondido — que no es lo que pide la Ley 29733.
 *
 * La advertencia dice las dos mitades, porque la segunda tranquiliza: lo que se
 * va es lo que identifica, y **el pedido se queda** con su importe y su fecha.
 * Sin decirlo, quien tiene que atender la solicitud duda de si va a romper su
 * contabilidad.
 */
export function BotonAnonimizar({
  phone,
  nombre,
}: {
  phone: string;
  nombre: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCliente, FormData>(
    anonimizar,
    {},
  );

  if (estado.hecho) {
    return (
      <p className="aviso aviso--ok" role="status">
        Datos personales borrados. Los pedidos siguen contando para tu
        facturación. <Link href="/panel/clientes">Volver a clientes</Link>
      </p>
    );
  }

  return (
    <>
      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
      <form action={accion} className="en-linea">
        <input type="hidden" name="phone" value={phone} />
        <ConfirmacionDestructiva
          titulo={`Anonimizar a ${nombre}`}
          advertencia={
            'Se borran su nombre, su teléfono y su dirección de entrega, en todos ' +
            'sus pedidos y para siempre. NO se borran los pedidos: su importe y su ' +
            'fecha siguen contando para tu facturación, que tiene cinco años de ' +
            'retención fiscal. No se puede deshacer.'
          }
          rotuloBoton="Anonimizar a solicitud del cliente"
          rotuloConfirmar="Sí, borrar sus datos personales"
          etiquetaMotivo="¿Por qué se anonimiza?"
          pendiente={pendiente}
        />
      </form>
    </>
  );
}
