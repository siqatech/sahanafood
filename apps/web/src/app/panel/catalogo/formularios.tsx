'use client';

import { useActionState } from 'react';
import {
  crearProducto,
  pausar,
  ponerPrecio,
  reanudar,
  type EstadoCarta,
} from './acciones';

/**
 * Los formularios de la carta.
 *
 * Son de cliente solo para poder enseñar el resultado de la acción junto al
 * campo que se acaba de tocar. Sin JavaScript siguen funcionando: cada uno es
 * un `<form>` que postea y la página se recarga con el cambio hecho.
 */

function Resultado({ estado }: { estado: EstadoCarta }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function FormularioPrecio({
  productId,
  channel,
  actual,
}: {
  productId: string;
  channel: string;
  actual: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCarta, FormData>(
    ponerPrecio,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="channel" value={channel} />
        <input
          name="price"
          className="corto"
          defaultValue={actual}
          inputMode="decimal"
          aria-label={`Precio en ${channel === 'base' ? 'todos los canales' : channel}`}
        />
        <button type="submit" disabled={pendiente}>
          {pendiente ? '…' : 'Guardar'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

export function FormularioPausa({
  productId,
  channel,
  pausado,
}: {
  productId: string;
  channel: string;
  pausado: boolean;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCarta, FormData>(
    pausado ? reanudar : pausar,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="channel" value={channel} />
        {pausado ? null : (
          <input
            name="reason"
            placeholder="¿Por qué?"
            aria-label="Motivo de la pausa"
          />
        )}
        <button type="submit" className="discreto" disabled={pendiente}>
          {pausado ? 'Reactivar' : 'Pausar'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

export function FormularioNuevoProducto({ brandId }: { brandId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoCarta, FormData>(
    crearProducto,
    {},
  );
  return (
    <form action={accion} className="ficha">
      <h2 style={{ marginTop: 0 }}>Añadir un plato</h2>
      <Resultado estado={estado} />
      <input type="hidden" name="brandId" value={brandId} />
      <div className="campo">
        <label htmlFor="nuevo-nombre">Nombre</label>
        <input id="nuevo-nombre" name="name" required />
      </div>
      <div className="campo">
        <label htmlFor="nuevo-sku">
          Código (SKU) <span className="tarjeta__pie">— opcional</span>
        </label>
        <input id="nuevo-sku" name="sku" />
        <p className="tarjeta__pie">
          Con código puedes renombrar el plato sin que se duplique ni pierda su
          historial de ventas.
        </p>
      </div>
      <div className="campo">
        <label htmlFor="nuevo-precio">Precio para todos los canales</label>
        <input
          id="nuevo-precio"
          name="price"
          className="corto"
          inputMode="decimal"
          placeholder="12.50"
        />
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Creando…' : 'Crear plato'}
      </button>
    </form>
  );
}
