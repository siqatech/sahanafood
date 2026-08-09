'use client';

import { useActionState, useState } from 'react';
import { resolver, rechazar, type EstadoExcepcion } from './acciones';
import type { LineaExterna } from './lineas';
import type { ProductoVendible } from '../../../lib/panel-api';

/**
 * Los dos formularios de la bandeja: resolver y rechazar.
 *
 * ### Por qué este SÍ necesita JavaScript
 *
 * El resto del panel y toda la tienda funcionan sin él (T5.14). Aquí no se
 * puede: los modificadores obligatorios de un plato **dependen del plato que se
 * acaba de elegir**, y sin JavaScript eso obliga a un paso de ida y vuelta al
 * servidor por cada línea. Se eligió lo contrario —cargar los platos vendibles
 * con sus grupos y reaccionar en el navegador— porque esta pantalla la usa un
 * encargado en su escritorio, no un comprador en un móvil con 3G.
 *
 * Sin JavaScript el formulario sigue enviándose y sirve para los platos que no
 * tienen nada obligatorio, que es más que nada.
 */

function Resultado({ estado }: { estado: EstadoExcepcion }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

/**
 * Una línea del pedido externo: a qué plato nuestro corresponde, cuántos, y
 * qué hay que elegir para poder pedirlo.
 */
function Linea({
  indice,
  linea,
  productos,
}: {
  indice: number;
  linea: LineaExterna;
  productos: ProductoVendible[];
}) {
  const [elegido, setElegido] = useState('');
  const producto = productos.find((p) => p.id === elegido);
  // Solo los OBLIGATORIOS. Los opcionales —extra de queso— no los mandó el
  // canal y añadirlos por nuestra cuenta sería cobrar de más.
  const obligatorios = (producto?.modifierGroups ?? []).filter(
    (g) => g.minSelections > 0,
  );

  return (
    <tr>
      <td>
        <input type="hidden" name={`sku-${indice}`} value={linea.sku} />
        <strong>{linea.sku === '' ? '(sin SKU)' : linea.sku}</strong>
        {linea.nombre ? (
          <>
            <br />
            <span className="tarjeta__pie">{linea.nombre}</span>
          </>
        ) : null}
      </td>
      <td>
        <select
          name={`producto-${indice}`}
          value={elegido}
          onChange={(e) => {
            setElegido(e.target.value);
          }}
          aria-label={`Plato para ${linea.sku || 'la línea sin SKU'}`}
        >
          {/* La opción vacía va primera y sin preseleccionar nada:
              preseleccionar el primer plato de la carta haría que pulsar
              «Resolver» sin mirar vendiera otra cosa. */}
          <option value="">— descartar esta línea —</option>
          {productos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {obligatorios.map((g) => (
          <div key={g.id} style={{ marginTop: 6 }}>
            <select
              name={`modificador-${indice}`}
              defaultValue={g.options[0]?.id ?? ''}
              aria-label={`${g.name} de ${linea.sku || 'la línea sin SKU'}`}
            >
              {g.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {g.name}: {o.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </td>
      <td>
        <input
          name={`cantidad-${indice}`}
          type="number"
          min={1}
          className="corto"
          defaultValue={linea.cantidad}
          aria-label={`Cantidad de ${linea.sku || 'la línea sin SKU'}`}
        />
      </td>
    </tr>
  );
}

export function FormularioResolver({
  orderId,
  lineas,
  productos,
  connectionId,
  puedeMapear,
}: {
  orderId: string;
  lineas: LineaExterna[];
  productos: ProductoVendible[];
  connectionId: string | null;
  puedeMapear: boolean;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoExcepcion, FormData>(
    resolver,
    {},
  );

  // Sin líneas reconocidas se ofrece una en blanco: el operador tiene el JSON
  // crudo delante y puede armar el pedido a mano. Una pantalla sin ningún campo
  // sería un callejón sin salida.
  const filas: LineaExterna[] =
    lineas.length > 0 ? lineas : [{ sku: '', cantidad: 1, nombre: null }];

  return (
    <form action={accion}>
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="total" value={filas.length} />
      {connectionId ? (
        <input type="hidden" name="connectionId" value={connectionId} />
      ) : null}

      <div className="tabla-envoltorio">
        <table>
          <thead>
            <tr>
              <th>Lo que mandó el canal</th>
              <th>Nuestro plato</th>
              <th>Cantidad</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((linea, i) => (
              <Linea
                key={`${linea.sku}-${i}`}
                indice={i}
                linea={linea}
                productos={productos}
              />
            ))}
          </tbody>
        </table>
      </div>

      {puedeMapear && connectionId ? (
        <p className="campo">
          <label>
            <input type="checkbox" name="recordar" defaultChecked /> Recordar
            estos SKU para la próxima
          </label>
          <br />
          <span className="tarjeta__pie">
            Sin esto, el siguiente pedido con el mismo plato vuelve a caer aquí.
          </span>
        </p>
      ) : null}

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Resolviendo…' : 'Resolver y mandar a cocina'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function FormularioRechazar({ orderId }: { orderId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoExcepcion, FormData>(
    rechazar,
    {},
  );
  return (
    <form action={accion} className="en-linea">
      <input type="hidden" name="orderId" value={orderId} />
      <input
        name="reason"
        placeholder="Motivo del rechazo"
        aria-label="Motivo del rechazo"
      />
      <button type="submit" className="discreto" disabled={pendiente}>
        {pendiente ? '…' : 'Rechazar'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}
