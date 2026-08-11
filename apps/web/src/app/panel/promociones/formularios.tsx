'use client';

import { useActionState } from 'react';
import {
  guardarPromocion,
  cambiarEstado,
  marcarBienvenida,
  type EstadoPromocion,
} from './acciones';
import type { PromocionDelPanel } from '../../../lib/panel-api';

/**
 * Alta de una promoción.
 *
 * El descuento se pide en POR CIENTO, que es como lo piensa quien lo decide.
 * La conversión a puntos básicos —la unidad interna, entera, que impide que un
 * descuento pase por coma flotante— la hace el servidor.
 */
export function FormularioPromocion({
  marcas,
}: {
  marcas: Array<{ id: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoPromocion, FormData>(
    guardarPromocion,
    {},
  );
  const v = estado.valores;

  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="pr-marca">Marca</label>
        <select id="pr-marca" name="brandId" defaultValue={marcas[0]?.id ?? ''}>
          {marcas.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      <div className="campo">
        <label htmlFor="pr-codigo">Código</label>
        <input
          id="pr-codigo"
          name="code"
          className="corto"
          defaultValue={v?.['code'] ?? ''}
          placeholder="BIENVENIDO"
          autoCapitalize="characters"
        />
        <span className="tarjeta__pie">
          Se lo vas a dictar por teléfono y lo van a teclear en un móvil: corto,
          sin acentos y sin espacios.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="pr-pct">Descuento (%)</label>
        <input
          id="pr-pct"
          name="porcentaje"
          className="corto"
          inputMode="decimal"
          defaultValue={v?.['porcentaje'] ?? '10'}
        />
      </div>

      <div className="campo">
        <label htmlFor="pr-min">Pedido mínimo (S/)</label>
        <input
          id="pr-min"
          name="minOrder"
          className="corto"
          inputMode="decimal"
          defaultValue={v?.['minOrder'] ?? ''}
          placeholder="50.00"
        />
        <span className="tarjeta__pie">
          Opcional. Es lo que evita que un 20 % se lleve el margen de una
          gaseosa: con mínimo, el descuento sale del ticket que sube.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="pr-max">Cuántas veces se puede usar</label>
        <input
          id="pr-max"
          name="maxUses"
          className="corto"
          inputMode="numeric"
          defaultValue={v?.['maxUses'] ?? ''}
          placeholder="sin límite"
        />
      </div>

      <div className="consentimiento">
        <input id="pr-bienvenida" name="isWelcome" type="checkbox" />
        <label htmlFor="pr-bienvenida">
          Anunciarla a quien entra por primera vez. Solo puede haber una: si ya
          tenías otra, esta la reemplaza.
        </label>
      </div>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Guardando…' : 'Crear promoción'}
      </button>
      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
      {estado.ok ? <p className="tarjeta__pie">{estado.ok}</p> : null}
    </form>
  );
}

/** Encender, apagar y elegir cuál se anuncia. */
export function Interruptores({ promocion }: { promocion: PromocionDelPanel }) {
  const [, accionEstado, pendienteEstado] = useActionState<
    EstadoPromocion,
    FormData
  >(cambiarEstado, {});
  const [, accionBienvenida, pendienteBienvenida] = useActionState<
    EstadoPromocion,
    FormData
  >(marcarBienvenida, {});

  const comunes = (
    <>
      <input type="hidden" name="id" value={promocion.id} />
      <input type="hidden" name="brandId" value={promocion.brandId ?? ''} />
      <input type="hidden" name="code" value={promocion.code} />
      <input type="hidden" name="kind" value={promocion.kind} />
      <input
        type="hidden"
        name="percentBps"
        value={promocion.percentBps ?? 0}
      />
      <input type="hidden" name="minOrder" value={promocion.minOrder} />
    </>
  );

  return (
    <div className="en-linea">
      <form action={accionEstado}>
        {comunes}
        <input
          type="hidden"
          name="esBienvenida"
          value={promocion.isWelcome ? '1' : '0'}
        />
        <button
          type="submit"
          name="accion"
          value={promocion.active ? 'apagar' : 'encender'}
          disabled={pendienteEstado}
        >
          {promocion.active ? 'Apagar' : 'Encender'}
        </button>
      </form>

      {promocion.active ? (
        <form action={accionBienvenida}>
          {comunes}
          <button
            type="submit"
            name="accion"
            value={promocion.isWelcome ? 'quitar' : 'poner'}
            disabled={pendienteBienvenida}
          >
            {promocion.isWelcome ? 'Dejar de anunciar' : 'Anunciar de entrada'}
          </button>
        </form>
      ) : null}
    </div>
  );
}
