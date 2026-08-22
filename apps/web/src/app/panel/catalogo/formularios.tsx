'use client';

import { useActionState } from 'react';
import {
  crearProducto,
  pausar,
  ponerFoto,
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
  const donde = channel === 'base' ? 'todos los canales' : channel;
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
          aria-label={`Precio en ${donde}`}
        />
        {/* El botón dice «Guardar» —encima de su columna no hace falta más—
            pero su nombre accesible dice CUÁL. En la fila de un plato hay
            cuatro botones de guardar; con un lector de pantalla, cuatro
            «Guardar» seguidos no se distinguen.

            «Guardar el precio de web» y no «Guardar precio en web»: el nombre
            del botón NO debe contener el del campo —«Precio en web»—, o
            cualquier búsqueda por etiqueta encuentra los dos. */}
        <button
          type="submit"
          disabled={pendiente}
          aria-label={`Guardar el precio de ${donde}`}
        >
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

/**
 * La foto, en miniatura y con su campo.
 *
 * La miniatura es el propio control: enseña lo que el cliente verá, que es la
 * única forma de detectar que la URL pegada apunta a otra cosa. Cuando no hay
 * foto se ve un hueco con la palabra «sin foto» — un plato sin foto en la carta
 * es trabajo pendiente, igual que uno sin precio, y ocultarlo lo eterniza.
 */
export function FormularioFoto({
  productId,
  nombre,
  actual,
}: {
  productId: string;
  nombre: string;
  actual: string | null;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCarta, FormData>(
    ponerFoto,
    {},
  );
  return (
    <>
      <form action={accion} className="foto-campo">
        <input type="hidden" name="productId" value={productId} />
        {actual ? (
          // Sin `next/image`: la foto vive en el servidor del dueño, no en uno
          // configurado en `next.config`, y el optimizador rechazaría el
          // dominio. Es el mismo criterio que la tienda.
          <img
            className="foto-campo__miniatura"
            src={actual}
            alt={`Foto de ${nombre}`}
            width={56}
            height={56}
            loading="lazy"
          />
        ) : (
          <span className="foto-campo__hueco" aria-hidden="true">
            sin foto
          </span>
        )}
        <input
          name="imageUrl"
          type="url"
          defaultValue={actual ?? ''}
          placeholder="https://…"
          aria-label={`Dirección de la foto de ${nombre}`}
        />
        {/* «Guardar foto» y no «Guardar» a secas: en la misma fila hay tres
            botones de guardar precio, y tres controles con el mismo nombre
            accesible son tres formas de pulsar el equivocado —con un lector de
            pantalla, la única. */}
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Guardar foto'}
        </button>
        {actual ? (
          <button
            type="submit"
            name="quitar"
            value="1"
            className="discreto"
            disabled={pendiente}
          >
            Quitar foto
          </button>
        ) : null}
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
