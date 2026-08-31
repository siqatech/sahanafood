import Link from 'next/link';
import { panel, type DiferenciaDeVersiones } from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { Vacio } from '../../vacio';
import { momento } from '../../fechas';
import { FormularioPublicar } from './formularios';
import {
  resumenDeDiferencias,
  rotuloDeCampo,
  valorLegible,
  solesDeMenores,
  tocaElPrecio,
} from './diferencias';

/**
 * Publicar la carta (T4.06, spec 04).
 *
 * La publicación versionada estaba entera desde T4.06 —versión inmutable con
 * checksum, historial, descarga y diff calculado en `@sahana/domain`, el mismo
 * código que aplicará el POS— y **no la llamaba ninguna pantalla**. La foto de
 * la carta que consumen los canales no se podía emitir ni mirar desde el
 * producto, y el criterio de aceptación de la spec 04 —«diff de versiones
 * descargable»— no se cumplía por falta de una página.
 *
 * Se publica **por canal**, y no es un detalle de implementación: el precio de
 * un plato en un marketplace no es el de la tienda propia, así que cada canal
 * tiene su propia línea de versiones y se publica cuando toca.
 */

/** Los canales que un dueño publica a mano. */
const CANALES = ['web', 'pos', 'rappi'] as const;

function esCanal(v: unknown): v is (typeof CANALES)[number] {
  return (
    typeof v === 'string' && CANALES.includes(v as (typeof CANALES)[number])
  );
}

export default async function PublicarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const estructura = await cargar('/panel/catalogo/publicar', yaSeIntento, () =>
    panel.estructura(),
  );
  const marcas = estructura.brands;
  const marcaPedida =
    typeof params['marca'] === 'string' ? params['marca'] : undefined;
  const marca = marcas.find((m) => m.id === marcaPedida) ?? marcas[0];

  if (!marca) {
    return (
      <>
        <h1>Publicar la carta</h1>
        <p className="panel__vacio">
          La carta cuelga de una marca y todavía no hay ninguna. Empieza por{' '}
          <Link href="/panel/negocio">tu negocio</Link>.
        </p>
      </>
    );
  }

  const canal = esCanal(params['canal']) ? params['canal'] : 'web';
  const versiones = await panel
    .versionesDeCarta(marca.id, canal)
    .catch(() => []);

  // El diff se pide solo si hay dos versiones que comparar y alguien lo pidió.
  // Por defecto se comparan las DOS ÚLTIMAS, que es la pregunta que se hace
  // quien acaba de publicar: «¿qué acabo de cambiar?».
  const [ultima, penultima] = versiones;
  const desde = Number(params['desde'] ?? penultima?.version ?? 0);
  const hasta = Number(params['hasta'] ?? ultima?.version ?? 0);
  let diff: DiferenciaDeVersiones | null = null;
  if (desde > 0 && hasta > 0 && desde !== hasta) {
    diff = await panel
      .diferenciaDeCarta(marca.id, canal, desde, hasta)
      .catch(() => null);
  }

  return (
    <>
      <h1>Publicar la carta de {marca.name}</h1>
      <p className="panel__subtitulo">
        Publicar toma una foto de la carta de un canal y la congela con un
        número. Es lo que consumen los canales y lo que la tablet guarda para
        vender sin conexión — y lo que permite responder, un mes después, qué
        precio tenía un plato el martes.
      </p>

      <p>
        {CANALES.map((c) => (
          <Link
            key={c}
            href={`/panel/catalogo/publicar?marca=${marca.id}&canal=${c}`}
            className={c === canal ? 'etiqueta etiqueta--unido' : 'etiqueta'}
            style={{ marginRight: 8 }}
          >
            {c}
          </Link>
        ))}
        {marcas.length > 1
          ? marcas
              .filter((m) => m.id !== marca.id)
              .map((m) => (
                <Link
                  key={m.id}
                  href={`/panel/catalogo/publicar?marca=${m.id}&canal=${canal}`}
                  className="etiqueta"
                  style={{ marginRight: 8 }}
                >
                  {m.name}
                </Link>
              ))
          : null}
      </p>

      <FormularioPublicar brandId={marca.id} channel={canal} />

      <h2>Versiones de {canal}</h2>
      {versiones.length === 0 ? (
        <Vacio titulo={`La carta de ${canal} no se ha publicado nunca`}>
          <p>
            Hasta que se publique, este canal no tiene una foto de la carta que
            consumir. Publícala arriba.
          </p>
        </Vacio>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Versión</th>
                <th>Publicada</th>
                <th className="dinero">Platos</th>
                <th>Huella</th>
              </tr>
            </thead>
            <tbody>
              {versiones.map((v) => (
                <tr key={v.id}>
                  <td>
                    <strong>#{v.version}</strong>
                    {v.version === ultima?.version ? (
                      <>
                        {' '}
                        <span className="etiqueta etiqueta--unido">en uso</span>
                      </>
                    ) : null}
                  </td>
                  <td>{momento(v.publishedAt)}</td>
                  <td className="dinero">{v.productCount}</td>
                  {/* La huella se enseña corta: sirve para comparar dos
                      versiones de un vistazo, no para leerla entera. */}
                  <td className="tarjeta__pie">{v.checksum.slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {versiones.length > 1 ? (
        <>
          <h2>Qué cambió</h2>
          <form method="get" className="en-linea">
            <input type="hidden" name="marca" value={marca.id} />
            <input type="hidden" name="canal" value={canal} />
            <label htmlFor="dif-desde">De la</label>
            <select id="dif-desde" name="desde" defaultValue={String(desde)}>
              {versiones.map((v) => (
                <option key={v.id} value={v.version}>
                  #{v.version}
                </option>
              ))}
            </select>
            <label htmlFor="dif-hasta">a la</label>
            <select id="dif-hasta" name="hasta" defaultValue={String(hasta)}>
              {versiones.map((v) => (
                <option key={v.id} value={v.version}>
                  #{v.version}
                </option>
              ))}
            </select>
            <button type="submit">Comparar</button>
          </form>

          {diff === null ? (
            <p className="tarjeta__pie">
              Elige dos versiones distintas para ver la diferencia.
            </p>
          ) : (
            <>
              <p>
                <strong>{resumenDeDiferencias(diff)}</strong>
              </p>

              {diff.added.length > 0 ? (
                <>
                  <h3>Entran en la carta</h3>
                  <ul className="opciones">
                    {diff.added.map((p) => (
                      <li key={p.id}>
                        {p.name}
                        {typeof p.priceMinor === 'number'
                          ? ` · S/ ${solesDeMenores(p.priceMinor)}`
                          : ''}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {diff.removed.length > 0 ? (
                <>
                  <h3>Salen de la carta</h3>
                  <ul className="opciones">
                    {diff.removed.map((p) => (
                      <li key={p.id}>{p.name}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {diff.changed.length > 0 ? (
                <>
                  <h3>Cambian</h3>
                  <div className="tabla-envoltorio">
                    <table>
                      <thead>
                        <tr>
                          <th>Plato</th>
                          <th>Qué</th>
                          <th>Antes</th>
                          <th>Ahora</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.changed.map((p) =>
                          p.changes.map((c) => (
                            <tr
                              key={`${p.id}-${c.field}`}
                              /* Un precio se marca aparte: es el único cambio
                                 que se cobra. Un nombre distinto se corrige
                                 mañana; un precio mal publicado se cobra hasta
                                 que alguien lo vea. */
                              className={
                                tocaElPrecio(p) && c.field === 'priceMinor'
                                  ? 'ficha--revision'
                                  : undefined
                              }
                            >
                              <td>{p.name}</td>
                              <td>{rotuloDeCampo(c.field)}</td>
                              <td>{valorLegible(c.field, c.from)}</td>
                              <td>
                                <strong>{valorLegible(c.field, c.to)}</strong>
                              </td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </>
          )}
        </>
      ) : null}

      <p className="tarjeta__pie">
        La tablet todavía descarga la carta viva y no una versión publicada
        (ADR-0019). Publicar deja la foto y su diff disponibles; que el POS los
        consuma es un cambio aparte, con sus propias consecuencias offline.
      </p>
    </>
  );
}
