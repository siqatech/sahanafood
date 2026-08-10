'use client';

import { useActionState } from 'react';
import {
  guardarInsumo,
  guardarReceta,
  type EstadoInventario,
} from './acciones';

/**
 * Alta de insumos y recetas (spec 08: «CRUD insumos/recetas»).
 *
 * De cliente solo para enseñar el resultado junto al campo. Sin JavaScript
 * siguen funcionando: son `<form>` contra acciones de servidor.
 */

function Resultado({ estado }: { estado: EstadoInventario }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function FormularioInsumo() {
  const [estado, accion, pendiente] = useActionState<
    EstadoInventario,
    FormData
  >(guardarInsumo, {});
  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="ins-name">Nombre</label>
        <input id="ins-name" name="name" placeholder="Pollo entero" />
      </div>
      <div className="campo">
        <label htmlFor="ins-unit">Unidad</label>
        {/* Solo tres, y no se pueden inventar más: la unidad vive en el insumo
            y todo lo demás —stock, kardex, recetas— guarda números sin ella. */}
        <select id="ins-unit" name="unit" defaultValue="g">
          <option value="g">Gramos</option>
          <option value="ml">Mililitros</option>
          <option value="unit">Unidades</option>
        </select>
      </div>
      <div className="campo">
        <label htmlFor="ins-costo">Costo por unidad</label>
        <input
          id="ins-costo"
          name="unitCost"
          className="corto"
          inputMode="decimal"
          placeholder="0.012"
        />
        <span className="tarjeta__pie">
          Por gramo, mililitro o unidad — no por kilo. Es el número que
          multiplica cada consumo.
        </span>
      </div>
      <div className="campo">
        <label htmlFor="ins-min">Mínimo (opcional)</label>
        <input
          id="ins-min"
          name="minStock"
          className="corto"
          inputMode="decimal"
          placeholder="1000"
        />
      </div>
      <div className="campo">
        <label htmlFor="ins-sku">SKU (opcional)</label>
        <input id="ins-sku" name="sku" className="corto" />
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Guardando…' : 'Guardar insumo'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function FormularioReceta({
  insumos,
  productos,
}: {
  insumos: Array<{ id: string; name: string; unit: string }>;
  productos: Array<{ id: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<
    EstadoInventario,
    FormData
  >(guardarReceta, {});

  if (insumos.length === 0) {
    return (
      <p className="panel__vacio">
        Primero crea un insumo: una receta sin nada que consumir no descuenta.
      </p>
    );
  }

  return (
    <form action={accion}>
      <input type="hidden" name="yieldQuantity" value="1" />
      <input type="hidden" name="yieldUnit" value="unit" />

      <div className="campo">
        <label htmlFor="rec-producto">Plato</label>
        <select id="rec-producto" name="productId" defaultValue="">
          <option value="">— sin plato (subreceta) —</option>
          {productos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="tarjeta__pie">
          Colgar la receta de un plato es lo que hace que cada venta descuente
          sola.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="rec-name">Nombre de la receta</label>
        <input id="rec-name" name="name" placeholder="Pollo a la brasa" />
      </div>

      <div className="campo">
        <label htmlFor="rec-item">Consume</label>
        <select id="rec-item" name="itemId" defaultValue="">
          <option value="">— elige el insumo —</option>
          {insumos.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.unit})
            </option>
          ))}
        </select>
      </div>

      <div className="campo">
        <label htmlFor="rec-cant">Cantidad por plato</label>
        <input
          id="rec-cant"
          name="quantity"
          className="corto"
          inputMode="decimal"
          placeholder="275"
        />
        <span className="tarjeta__pie">
          En la unidad del insumo. Un pollo entero son unos 1200 g.
        </span>
      </div>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Guardando…' : 'Guardar receta'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}
