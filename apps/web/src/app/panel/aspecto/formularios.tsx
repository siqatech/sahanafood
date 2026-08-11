'use client';

import { useActionState, useState } from 'react';
import { guardarAspecto, type EstadoAspecto } from './acciones';
import type { AspectoDeTienda } from '../../../lib/panel-api';

/**
 * Los campos, con una vista previa al lado.
 *
 * La previa importa más de lo que parece: elegir un color a ciegas y tener que
 * abrir la tienda en otra pestaña para ver el resultado es lo que hace que nadie
 * termine de configurarlo. Aquí se ve al escribir.
 */
export function FormularioAspecto({
  marcaId,
  actual,
}: {
  marcaId: string;
  actual: AspectoDeTienda | null;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoAspecto, FormData>(
    guardarAspecto,
    {},
  );
  const v = estado.valores;

  const inicial = (campo: keyof AspectoDeTienda, porDefecto = ''): string =>
    v?.[campo] ?? actual?.[campo] ?? porDefecto;

  const [base, setBase] = useState(inicial('colorBase', '#c8102e'));
  const [texto, setTexto] = useState(inicial('colorTexto', '#1a1a1a'));
  const [nombre, setNombre] = useState(inicial('displayName'));
  const [lema, setLema] = useState(inicial('tagline'));

  return (
    <div className="aspecto">
      <form action={accion}>
        <input type="hidden" name="brandId" value={marcaId} />

        <div className="campo">
          <label htmlFor="as-nombre">Nombre que se anuncia</label>
          <input
            id="as-nombre"
            name="displayName"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="El Buen Sabor"
          />
          <span className="tarjeta__pie">
            Si lo dejas vacío se usa el nombre de la marca. Sirve para que en la
            tienda no aparezca la razón social entera.
          </span>
        </div>

        <div className="campo">
          <label htmlFor="as-lema">Lema</label>
          <input
            id="as-lema"
            name="tagline"
            value={lema}
            onChange={(e) => setLema(e.target.value)}
            placeholder="Pollo a la brasa desde 1998"
          />
        </div>

        <div className="campo">
          <label htmlFor="as-logo">Logo (dirección https://)</label>
          <input
            id="as-logo"
            name="logoUrl"
            defaultValue={inicial('logoUrl')}
            placeholder="https://…/logo.png"
          />
        </div>

        <div className="campo">
          <label htmlFor="as-portada">Imagen de portada (https://)</label>
          <input
            id="as-portada"
            name="coverUrl"
            defaultValue={inicial('coverUrl')}
            placeholder="https://…/portada.jpg"
          />
          <span className="tarjeta__pie">
            Sale ancha y recortada encima de la carta. Una foto apaisada de tu
            local o de tu plato estrella funciona mejor que un cartel.
          </span>
        </div>

        <div className="campo">
          <label htmlFor="as-base">Color principal</label>
          <div className="en-linea">
            <input
              id="as-base"
              name="colorBase"
              className="corto"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
            <input
              type="color"
              aria-label="Elegir color principal"
              value={/^#[0-9a-fA-F]{6}$/.test(base) ? base : '#c8102e'}
              onChange={(e) => setBase(e.target.value)}
            />
          </div>
          <span className="tarjeta__pie">
            El de los botones y el precio. En hexadecimal: #c8102e.
          </span>
        </div>

        <div className="campo">
          <label htmlFor="as-hover">Color al pasar el cursor</label>
          <input
            id="as-hover"
            name="colorHover"
            className="corto"
            defaultValue={inicial('colorHover')}
            placeholder="#a20d25"
          />
        </div>

        <div className="campo">
          <label htmlFor="as-texto">Color del texto</label>
          <div className="en-linea">
            <input
              id="as-texto"
              name="colorTexto"
              className="corto"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
            <input
              type="color"
              aria-label="Elegir color del texto"
              value={/^#[0-9a-fA-F]{6}$/.test(texto) ? texto : '#1a1a1a'}
              onChange={(e) => setTexto(e.target.value)}
            />
          </div>
        </div>

        <button type="submit" disabled={pendiente}>
          {pendiente ? 'Guardando…' : 'Guardar'}
        </button>
        {estado.error ? <p className="panel__error">{estado.error}</p> : null}
        {estado.ok ? <p className="tarjeta__pie">{estado.ok}</p> : null}
      </form>

      <aside
        className="previa"
        style={
          {
            '--previa-marca': /^#[0-9a-fA-F]{6}$/.test(base) ? base : '#c8102e',
            '--previa-texto': /^#[0-9a-fA-F]{6}$/.test(texto)
              ? texto
              : '#1a1a1a',
          } as React.CSSProperties
        }
      >
        <p className="previa__rotulo">Así se verá</p>
        <div className="previa__marco">
          <div className="previa__cabecera">{nombre || 'Tu marca'}</div>
          {lema ? <p className="previa__lema">{lema}</p> : null}
          <div className="previa__plato">
            <strong>Pollo a la brasa</strong>
            <span className="previa__precio">S/ 32.00</span>
          </div>
          <div className="previa__boton">Añadir</div>
        </div>
      </aside>
    </div>
  );
}
