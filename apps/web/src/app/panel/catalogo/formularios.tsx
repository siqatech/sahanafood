'use client';

import { useActionState, useState } from 'react';
import { AvisoConDeshacer } from '../aviso';
import {
  crearProducto,
  pausar,
  ponerFoto,
  ponerPrecio,
  reanudar,
  cambiarComposicion,
  crearGrupoDeModificadores,
  crearOpcionDeModificador,
  cambiarGrupoDelProducto,
  type EstadoCarta,
} from './acciones';

/**
 * Los formularios de la carta.
 *
 * Son de cliente solo para poder enseñar el resultado de la acción junto al
 * campo que se acaba de tocar. Sin JavaScript siguen funcionando: cada uno es
 * un `<form>` que postea y la página se recarga con el cambio hecho.
 *
 * Precios, pausas y fotos llevan **deshacer de ocho segundos** (docs/25): son
 * las tres cosas que se tocan a diario y en tablet, y las tres se revierten
 * sin consecuencias. Lo que no se puede revertir de verdad no lo ofrece.
 */

function Resultado({
  estado,
  accionDeshacer,
}: {
  estado: EstadoCarta;
  accionDeshacer?: (form: FormData) => void;
}) {
  return (
    <AvisoConDeshacer
      ok={estado.ok}
      error={estado.error}
      deshacer={estado.deshacer}
      accionDeshacer={accionDeshacer}
    />
  );
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
        {/* El precio que había, para poder volver a él. Viaja en el formulario
            porque el navegador ya lo tiene en pantalla: volver a preguntárselo
            a la API sería una llamada de más por un dato que se acaba de
            enseñar. */}
        <input type="hidden" name="anterior" value={actual} />
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
      {/* Deshacer reenvía el precio anterior por esta misma acción. */}
      <Resultado estado={estado} accionDeshacer={accion} />
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
  // Un segundo enganche solo para deshacer: revertir una pausa es REACTIVAR, y
  // eso es otra acción. Reutilizar la de arriba no sirve — cambia de identidad
  // según `pausado`, justo el valor que la pausa acaba de cambiar.
  const [, accionReanudar] = useActionState<EstadoCarta, FormData>(
    reanudar,
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
      {/* Deshacer una pausa es reactivar; deshacer una reactivación exigiría
          escribir otra vez el motivo, así que esa no se ofrece. */}
      <Resultado estado={estado} accionDeshacer={accionReanudar} />
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
        <input type="hidden" name="anterior" value={actual ?? ''} />
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
      <Resultado estado={estado} accionDeshacer={accion} />
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
      <div className="campo">
        <label className="casilla" htmlFor="nuevo-combo">
          <input id="nuevo-combo" type="checkbox" name="isCombo" />
          Es un combo
        </label>
        <p className="tarjeta__pie">
          Un combo tiene precio propio y se compone de otros platos. El
          inventario se descuenta por lo que lleva dentro, así que hay que
          decirle de qué se compone — si no, se vende y no descuenta nada.
        </p>
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Creando…' : 'Crear plato'}
      </button>
    </form>
  );
}

/**
 * De qué se compone un combo (RN-CAT-04).
 *
 * No es una lista decorativa: **el inventario de un combo se descuenta por sus
 * componentes**. Uno con la lista vacía se vende igual y no baja el stock de
 * nada, así que el «cuánto me queda» se va desviando venta a venta y solo se
 * descubre cuadrando el almacén.
 *
 * La lista actual viaja escondida en cada formulario porque la API reemplaza la
 * composición entera: añadir un componente es mandar los que ya había más el
 * nuevo.
 */
export function ComposicionDelCombo({
  comboId,
  componentes,
  candidatos,
}: {
  comboId: string;
  componentes: Array<{
    productId: string;
    productName: string;
    quantity: number;
  }>;
  /** Los demás platos de la marca. Un combo no se lleva a sí mismo. */
  candidatos: Array<{ id: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCarta, FormData>(
    cambiarComposicion,
    {},
  );
  const actuales = JSON.stringify(
    componentes.map((c) => ({ productId: c.productId, quantity: c.quantity })),
  );
  const disponibles = candidatos.filter(
    (p) => p.id !== comboId && !componentes.some((c) => c.productId === p.id),
  );

  return (
    <div className="combo">
      {componentes.length === 0 ? (
        <p className="panel__error">
          Este combo no lleva nada: se vende y no descuenta insumos.
        </p>
      ) : (
        <ul className="opciones">
          {componentes.map((c) => (
            <li key={c.productId}>
              {c.quantity}× {c.productName}{' '}
              <form action={accion} className="en-linea">
                <input type="hidden" name="comboId" value={comboId} />
                <input type="hidden" name="actuales" value={actuales} />
                <input type="hidden" name="quitar" value={c.productId} />
                <button
                  type="submit"
                  className="discreto"
                  disabled={pendiente}
                  aria-label={`Quitar ${c.productName} del combo`}
                >
                  Quitar
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      {disponibles.length === 0 ? (
        <p className="tarjeta__pie">
          No queda ningún otro plato de esta marca que añadir.
        </p>
      ) : (
        <form action={accion} className="en-linea">
          <input type="hidden" name="comboId" value={comboId} />
          <input type="hidden" name="actuales" value={actuales} />
          <input
            name="cantidad"
            className="corto"
            inputMode="numeric"
            defaultValue={estado.valores?.['cantidad'] ?? '1'}
            aria-label={`Cuántas unidades lleva el combo ${comboId}`}
          />
          <select
            name="anadir"
            defaultValue={disponibles[0]?.id}
            aria-label={`Qué añadir al combo ${comboId}`}
          >
            {disponibles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="submit" className="discreto" disabled={pendiente}>
            {pendiente ? '…' : 'Añadir'}
          </button>
        </form>
      )}
      <Resultado estado={estado} />
    </div>
  );
}

/**
 * Crear la pregunta: «¿Con qué guarnición?», «¿Término de la carne?».
 *
 * El mínimo y el máximo se eligen con palabras y no con dos números sueltos:
 * «obligatoria, una sola» y «opcional, varias» es lo que un dueño tiene en la
 * cabeza; `minSelections=1, maxSelections=1` es cómo se guarda.
 */
export function FormularioGrupoDeModificadores({
  brandId,
}: {
  brandId: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCarta, FormData>(
    crearGrupoDeModificadores,
    {},
  );
  const [tipo, setTipo] = useState('obligatoria-una');
  const forma = FORMAS.find((f) => f.id === tipo) ?? FORMAS[0]!;

  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="brandId" value={brandId} />
        <input type="hidden" name="minSelections" value={forma.min} />
        <input type="hidden" name="maxSelections" value={forma.max} />
        <input
          name="name"
          placeholder="Guarnición"
          aria-label="Nombre de la pregunta"
          defaultValue={estado.valores?.['name'] ?? ''}
        />
        <select
          value={tipo}
          onChange={(e) => {
            setTipo(e.target.value);
          }}
          aria-label="Cómo se responde"
        >
          {FORMAS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.rotulo}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pendiente}>
          {pendiente ? '…' : 'Crear pregunta'}
        </button>
      </form>
      <p className="tarjeta__pie">{forma.explicacion}</p>
      <Resultado estado={estado} />
    </>
  );
}

/**
 * Las cuatro formas que de verdad se usan.
 *
 * Se podrían ofrecer los dos números y dejar al dueño combinarlos; lo que sale
 * de ahí es «mínimo 2, máximo 1» y un error del servidor. Estas cuatro cubren
 * la carta de un restaurante y ninguna es inválida.
 */
const FORMAS = [
  {
    id: 'obligatoria-una',
    rotulo: 'Obligatoria, una sola',
    min: 1,
    max: 1,
    explicacion:
      'Hay que responderla para poder pedir, y solo se elige una. Como el término de la carne.',
  },
  {
    id: 'opcional-una',
    rotulo: 'Opcional, una sola',
    min: 0,
    max: 1,
    explicacion: 'Se puede no elegir nada. Como una salsa aparte.',
  },
  {
    id: 'opcional-varias',
    rotulo: 'Opcional, varias',
    min: 0,
    max: 10,
    explicacion:
      'Extras: el cliente marca los que quiera, o ninguno. Como los toppings.',
  },
  {
    id: 'obligatoria-dos',
    rotulo: 'Obligatoria, exactamente dos',
    min: 2,
    max: 2,
    explicacion: 'Hay que elegir dos. Como las dos guarniciones de un menú.',
  },
] as const;

/** Añadir una opción a la pregunta, con lo que suma o resta al precio. */
export function FormularioOpcionDeModificador({
  groupId,
}: {
  groupId: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCarta, FormData>(
    crearOpcionDeModificador,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="groupId" value={groupId} />
        <input
          name="name"
          className="corto"
          placeholder="Papas fritas"
          aria-label={`Nombre de la opción para ${groupId}`}
          defaultValue={estado.valores?.['name'] ?? ''}
        />
        <input
          name="priceDelta"
          className="corto"
          inputMode="decimal"
          placeholder="+ S/"
          aria-label={`Diferencia de precio para ${groupId}`}
          defaultValue={estado.valores?.['priceDelta'] ?? ''}
        />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Añadir opción'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

/**
 * La casilla que decide si a ESTE plato se le hace la pregunta.
 *
 * Es un botón y no una casilla de verdad porque cada cambio es una escritura:
 * una casilla que se marca y no guarda hasta que alguien pulse «guardar» es la
 * forma más rápida de perder un cambio de carta.
 */
export function BotonGrupoDelProducto({
  productId,
  groupId,
  nombre,
  unido,
}: {
  productId: string;
  groupId: string;
  nombre: string;
  unido: boolean;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCarta, FormData>(
    cambiarGrupoDelProducto,
    {},
  );
  return (
    <form action={accion} className="en-linea">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="unir" value={unido ? '0' : '1'} />
      <button
        type="submit"
        className={unido ? 'etiqueta etiqueta--unido' : 'discreto'}
        disabled={pendiente}
      >
        {pendiente ? '…' : unido ? `✓ ${nombre}` : nombre}
      </button>
      {estado.error ? (
        <span className="panel__error">{estado.error}</span>
      ) : null}
    </form>
  );
}
