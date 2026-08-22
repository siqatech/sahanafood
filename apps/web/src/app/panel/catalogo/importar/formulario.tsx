'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { solesDeTexto } from '../../caja/dinero';
import { aplicar, previsualizar, type EstadoImportacion } from './acciones';

/**
 * Pegar la carta, verla, y solo entonces aplicarla.
 *
 * El orden es la característica, no el adorno: **el botón de aplicar no existe
 * hasta que hay una vista previa delante**. Con una casilla de «aplicar de
 * verdad» junto al de previsualizar, marcarla por error publica ciento ochenta
 * precios; así, aplicar sin haber mirado no es un descuido posible.
 */

const ROTULO: Record<string, string> = {
  nuevo: 'nuevo',
  actualiza: 'cambia',
  igual: 'sin cambios',
};

export function FormularioImportar({
  brandId,
  marca,
}: {
  brandId: string;
  marca: string;
}) {
  const [previa, accionPrevia, cargandoPrevia] = useActionState<
    EstadoImportacion,
    FormData
  >(previsualizar, {});
  const [hecho, accionAplicar, aplicando] = useActionState<
    EstadoImportacion,
    FormData
  >(aplicar, {});

  // Lo aplicado manda sobre la previa: tras aplicar, enseñar el «va a pasar»
  // haría dudar de si llegó a pasar.
  const estado = hecho.resultado || hecho.error ? hecho : previa;
  const resultado = estado.resultado;
  const yaAplicado = Boolean(hecho.resultado && !hecho.resultado.simulacion);

  return (
    <>
      <form action={accionPrevia} className="ficha">
        <input type="hidden" name="brandId" value={brandId} />
        <div className="campo">
          <label htmlFor="csv">Pega aquí las filas de tu Excel</label>
          <textarea
            id="csv"
            name="csv"
            rows={10}
            className="csv"
            defaultValue={estado.csv ?? ''}
            placeholder={
              'sku;nombre;categoria;precio_base;precio_web\nPOLLO-1;Pollo a la brasa;Pollos;S/ 55,00;59,00'
            }
          />
          <p className="tarjeta__pie">
            La primera fila son los nombres de columna. Separadas por{' '}
            <code>;</code> —que es como exporta el Excel en español— y con coma
            decimal: <code>45,90</code> son cuarenta y cinco soles con noventa.
            Cada canal es una columna <code>precio_web</code>,{' '}
            <code>precio_pos</code>… y <code>precio_base</code> es el que sirve
            a los canales sin precio propio.
          </p>
        </div>
        <button type="submit" disabled={cargandoPrevia}>
          {cargandoPrevia ? 'Leyendo…' : 'Ver qué va a pasar'}
        </button>
      </form>

      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
      {estado.ok ? (
        <p className="aviso aviso--ok" role="status">
          {estado.ok} <Link href="/panel/catalogo">Ver la carta</Link>
        </p>
      ) : null}

      {resultado ? (
        <>
          <h2>
            {yaAplicado ? 'Esto se aplicó' : 'Esto es lo que va a pasar'} en{' '}
            {marca}
          </h2>
          <p className="chips" role="group" aria-label="Resumen del cambio">
            <span className="chip">{resultado.nuevos} nuevos</span>
            <span className="chip">{resultado.actualizados} cambian</span>
            <span className="chip">{resultado.sinCambios} sin cambios</span>
          </p>
          {resultado.categoriasNuevas.length > 0 ? (
            <p className="tarjeta__pie">
              Se crearán {resultado.categoriasNuevas.length} categorías nuevas:{' '}
              {resultado.categoriasNuevas.join(', ')}.
            </p>
          ) : null}

          <div className="tabla-envoltorio">
            <table>
              <thead>
                <tr>
                  <th>Plato</th>
                  <th>Categoría</th>
                  <th className="dinero">Precio base</th>
                  <th>Qué pasa</th>
                </tr>
              </thead>
              <tbody>
                {resultado.filas.map((f) => (
                  <tr key={f.sku ?? f.nombre}>
                    <td>
                      <strong>{f.nombre}</strong>
                      {f.sku ? (
                        <>
                          <br />
                          <span className="tarjeta__pie">{f.sku}</span>
                        </>
                      ) : null}
                    </td>
                    <td>{f.categoria ?? '—'}</td>
                    <td className="dinero">
                      {f.precioBase ? `S/ ${solesDeTexto(f.precioBase)}` : '—'}
                      {/* El precio viejo tachado al lado del nuevo: es la
                          única forma de ver de un vistazo si la hoja trae una
                          subida que no se esperaba. */}
                      {f.efecto === 'actualiza' && f.precioAnterior ? (
                        <>
                          <br />
                          <span className="tarjeta__pie">
                            antes S/ {solesDeTexto(f.precioAnterior)}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <span className={`etiqueta efecto efecto--${f.efecto}`}>
                        {ROTULO[f.efecto] ?? f.efecto}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* El botón de aplicar SOLO aparece con la previa delante. */}
          {yaAplicado ? null : (
            <form action={accionAplicar} className="en-linea">
              <input type="hidden" name="brandId" value={brandId} />
              <input type="hidden" name="csv" value={estado.csv ?? ''} />
              <button type="submit" disabled={aplicando}>
                {aplicando ? 'Aplicando…' : `Aplicar a la carta de ${marca}`}
              </button>
              <span className="tarjeta__pie">
                Se puede volver a pegar la hoja corregida: importar dos veces no
                duplica nada.
              </span>
            </form>
          )}
        </>
      ) : null}
    </>
  );
}
