import { panel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import {
  FormularioLocal,
  FormularioMarca,
  FormularioHorario,
  FormularioFeriado,
  BotonQuitarFeriado,
  FormularioCocina,
  FormularioEstacion,
  FormularioMarcaCocina,
} from './formularios';

/**
 * El negocio: empresas, marcas, locales y cocinas (specs/ux/03, «Configuración»).
 *
 * Se toca poco —esto se define una vez y casi no cambia— así que la pantalla
 * es deliberadamente sobria: leer la estructura y añadir marca o local.
 *
 * **Lo que todavía NO se puede hacer aquí se dice, no se esconde**: zonas de
 * reparto, cocinas y estaciones siguen yendo por el archivo de configuración.
 * Un panel que ofreciera un botón para cada cosa y fallara en la mitad sería
 * peor que uno que dice dónde está el límite.
 *
 * Los HORARIOS sí están, y no por completar la lista: el horario es lo que
 * decide si la tienda acepta un pedido. Mal puesto, o se cocina comida que nadie
 * pidió a esa hora, o se rechazan pedidos con la cocina vacía — y las dos se
 * descubren tarde y por el lado del cliente.
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

  // Los horarios de cada local, en paralelo. Se degradan solos: quien entra a
  // dar de alta una marca tiene que poder hacerlo aunque esta lectura falle.
  const horarios = new Map(
    await Promise.all(
      estructura.locations.map(
        async (l) =>
          [l.id, await panel.horarios(l.id).catch(() => [])] as const,
      ),
    ),
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
                <th>Se produce en</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {estructura.brands.map((m) => {
                const suyas = estructura.kitchens.filter((k) =>
                  estructura.brandKitchens.some(
                    (l) => l.brandId === m.id && l.kitchenId === k.id,
                  ),
                );
                const libres = estructura.kitchens
                  .filter((k) => !suyas.some((s) => s.id === k.id))
                  .map((k) => ({
                    id: k.id,
                    name: k.name,
                    local:
                      estructura.locations.find((l) => l.id === k.locationId)
                        ?.name ?? 'local',
                  }));
                return (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{m.slug}</td>
                    <td>
                      {/* RN-ORG-01: una marca sin cocina asignada NO PUEDE
                          recibir pedidos — Ordering lo valida y rechaza la
                          venta. Es lo primero que hay que ver de una marca
                          nueva, y hasta ahora no se veía en ninguna parte. */}
                      {suyas.length === 0 ? (
                        <span className="panel__error">
                          en ninguna: no puede recibir pedidos
                        </span>
                      ) : (
                        suyas.map((k) => k.name).join(', ')
                      )}
                      <FormularioMarcaCocina brandId={m.id} cocinas={libres} />
                    </td>
                    <td>
                      <span className="etiqueta">
                        {m.active ? 'activa' : 'inactiva'}
                      </span>
                    </td>
                  </tr>
                );
              })}
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
                <th>Cocinas y estaciones</th>
              </tr>
            </thead>
            <tbody>
              {estructura.locations.map((l) => {
                const cocinas = estructura.kitchens.filter(
                  (k) => k.locationId === l.id,
                );
                return (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td>{l.address}</td>
                    <td>
                      {cocinas.length === 0 ? (
                        <p className="panel__error">
                          Sin cocina no hay dónde producir: ninguna marca podrá
                          vender desde este local.
                        </p>
                      ) : (
                        <ul className="opciones">
                          {cocinas.map((k) => {
                            const estaciones = estructura.stations.filter(
                              (e) => e.kitchenId === k.id,
                            );
                            return (
                              <li key={k.id}>
                                <strong>{k.name}</strong>{' '}
                                {/* Los tickets salen a las ESTACIONES: una
                                    cocina sin ninguna no enseña nada en el KDS
                                    por mucho que entren pedidos. */}
                                {estaciones.length === 0 ? (
                                  <span className="panel__error">
                                    sin estaciones: el KDS no enseñará nada
                                  </span>
                                ) : (
                                  estaciones.map((e) => e.name).join(' · ')
                                )}
                                <FormularioEstacion kitchenId={k.id} />
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <FormularioCocina locationId={l.id} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Horarios</h2>
      <p className="panel__subtitulo">
        A qué hora abre cada local. Es lo que decide si la tienda acepta un
        pedido, así que un horario mal puesto no da error en ninguna pantalla:
        se descubre cuando un cliente pide con el local cerrado.
      </p>

      {estructura.locations.length === 0 ? (
        <p className="panel__vacio">
          Los horarios cuelgan de un local. Crea uno abajo.
        </p>
      ) : (
        estructura.locations.map((l) => {
          // El horario general del local: sin marca y sin canal. Los que la API
          // permite por marca o por canal se enseñan aparte y no se editan aquí
          // — tres ejes en un mismo formulario no se puede leer.
          const suyos = horarios.get(l.id) ?? [];
          const general = suyos.find(
            (h) => h.brandId === null && h.channel === null,
          );
          const acotados = suyos.filter(
            (h) => h.brandId !== null || h.channel !== null,
          );
          const semana = general?.weekly ?? [];
          const feriados = general?.exceptions ?? [];

          return (
            <section key={l.id}>
              <h3>{l.name}</h3>
              <FormularioHorario
                locationId={l.id}
                weekly={semana}
                feriados={feriados}
              />

              <h4>Feriados y días especiales</h4>
              {feriados.length === 0 ? (
                <p className="tarjeta__pie">
                  Ninguno anotado. El 28 de julio y el 25 de diciembre no se
                  cierran solos.
                </p>
              ) : (
                <ul className="opciones">
                  {feriados.map((f) => (
                    <li key={f.date}>
                      <strong>{f.date}</strong>{' '}
                      {f.ranges.length === 0
                        ? 'cerrado todo el día'
                        : f.ranges
                            .map((r) => `${r.opensAt}–${r.closesAt}`)
                            .join(', ')}{' '}
                      <BotonQuitarFeriado
                        locationId={l.id}
                        fecha={f.date}
                        weekly={semana}
                        feriados={feriados}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <FormularioFeriado
                locationId={l.id}
                weekly={semana}
                feriados={feriados}
              />

              {acotados.length > 0 ? (
                <p className="tarjeta__pie">
                  Este local tiene además {acotados.length} horario
                  {acotados.length === 1 ? '' : 's'} por marca o canal, puestos
                  con el archivo de configuración. Mandan sobre el general y
                  todavía se editan ahí.
                </p>
              ) : null}
            </section>
          );
        })
      )}

      <h2>Añadir</h2>
      <FormularioMarca companyId={empresa.id} />
      <FormularioLocal companyId={empresa.id} />

      <p className="tarjeta__pie">
        Las zonas de reparto todavía se configuran con el archivo de{' '}
        <code>docs/34-puesta-en-marcha.md</code> §5: un polígono se dibuja en un
        mapa, y ese mapa es una pantalla aparte. Desunir una marca de una cocina
        tampoco está: la API solo une, y qué pasa con los pedidos en curso al
        desunir es una decisión que la spec 03 no fija.
      </p>
    </>
  );
}
