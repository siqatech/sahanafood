import { panel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { FormularioAspecto } from './formularios';

/**
 * Cómo se ve tu tienda.
 *
 * Resuelve PA-12 con la referencia que dio el propietario: la pantalla de
 * *Branding* de Deliverect —nombre, logo, portada y colores— y su promesa de
 * que la web de pedidos «se vea tuya».
 *
 * Va por MARCA y no por negocio porque un tenant multimarca es el caso normal
 * aquí: la misma cocina sirve dos marcas con dos dominios y dos públicos, y con
 * los colores en el negocio las dos tiendas se verían iguales.
 */

export const dynamic = 'force-dynamic';

export default async function AspectoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const elegida = typeof params['marca'] === 'string' ? params['marca'] : '';

  const estructura = await cargar('/panel/aspecto', yaSeIntento, () =>
    panel.estructura(),
  );
  const marcas = estructura.brands ?? [];
  const marcaId = elegida || marcas[0]?.id || '';
  const actual = marcaId
    ? await panel.aspecto(marcaId).catch(() => null)
    : null;

  return (
    <>
      <h1>Cómo se ve tu tienda</h1>
      <p className="panel__subtitulo">
        Tu logo, tu portada y tus colores. Lo que cambies aquí lo ve el cliente
        en tu dominio, sin que aparezca nuestra marca por ningún lado.
      </p>

      {marcas.length > 1 ? (
        <form method="get" className="en-linea">
          <label htmlFor="as-marca">Marca</label>
          <select id="as-marca" name="marca" defaultValue={marcaId}>
            {marcas.map((m: { id: string; name: string }) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button type="submit">Ver</button>
        </form>
      ) : null}

      {marcaId ? (
        <FormularioAspecto marcaId={marcaId} actual={actual} />
      ) : (
        <p className="panel__vacio">
          Todavía no tienes ninguna marca. Créala en Negocio y vuelve.
        </p>
      )}
    </>
  );
}
