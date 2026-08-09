import { panel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { FormularioLocal, FormularioMarca } from './formularios';

/**
 * El negocio: empresas, marcas, locales y cocinas (specs/ux/03, «Configuración»).
 *
 * Se toca poco —esto se define una vez y casi no cambia— así que la pantalla
 * es deliberadamente sobria: leer la estructura y añadir marca o local.
 *
 * **Lo que todavía NO se puede hacer aquí se dice, no se esconde**: zonas de
 * reparto, horarios, cocinas y estaciones siguen yendo por el archivo de
 * configuración. Un panel que ofreciera un botón para cada cosa y fallara en la
 * mitad sería peor que uno que dice dónde está el límite.
 */
export default async function NegocioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const estructura = await cargar(
    '/panel/negocio',
    params['intento'] === '1',
    () => panel.estructura(),
  );

  const empresa = estructura.companies[0];

  if (!empresa) {
    return (
      <>
        <h1>Tu negocio</h1>
        <p className="panel__vacio">
          Todavía no hay ninguna empresa dada de alta. La crea quien levanta el
          servidor, con el archivo de configuración (
          <code>docs/34-puesta-en-marcha.md</code> §5): hace falta el RUC, y un
          RUC mal escrito se descubre el día que el OSE rechaza la primera
          boleta.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Tu negocio</h1>
      <p className="panel__subtitulo">
        {empresa.legalName} · RUC {empresa.taxId}
      </p>

      <h2>Marcas</h2>
      {estructura.brands.length === 0 ? (
        <p className="panel__vacio">
          Sin marcas todavía. La carta y la tienda cuelgan de una marca, así que
          es lo primero.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Marca</th>
                <th>Identificador</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {estructura.brands.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{m.slug}</td>
                  <td>
                    <span className="etiqueta">
                      {m.active ? 'activa' : 'inactiva'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Locales</h2>
      {estructura.locations.length === 0 ? (
        <p className="panel__vacio">
          Sin locales todavía. Un pedido necesita un local donde cocinarse.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Local</th>
                <th>Dirección</th>
                <th>Cocinas</th>
              </tr>
            </thead>
            <tbody>
              {estructura.locations.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td>{l.address}</td>
                  <td>
                    {estructura.kitchens.filter((k) => k.locationId === l.id)
                      .length || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Añadir</h2>
      <FormularioMarca companyId={empresa.id} />
      <FormularioLocal companyId={empresa.id} />

      <p className="tarjeta__pie">
        Zonas de reparto, horarios, cocinas y estaciones todavía se configuran
        con el archivo de <code>docs/34-puesta-en-marcha.md</code> §5. La API ya
        las soporta; lo que falta es la pantalla.
      </p>
    </>
  );
}
