import Link from 'next/link';
import { panel } from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { Vacio } from '../../vacio';
import { FormularioImportar } from './formulario';

/**
 * Importar la carta desde un Excel (docs/26 §2).
 *
 * El importador existía desde antes, pero como guion de línea de comandos: le
 * servía a quien da de alta clientes desde su máquina, y no al dueño que está
 * dentro del panel con su hoja abierta en otra pestaña. Escribir 180 platos a
 * mano es una tarde, y esa tarde es justo lo que separa la métrica de docs/26
 * —de alta a primera venta en menos de un día— de no cumplirse.
 */
export default async function ImportarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const marcaPedida =
    typeof params['marca'] === 'string' ? params['marca'] : undefined;

  const estructura = await cargar('/panel/catalogo/importar', yaSeIntento, () =>
    panel.estructura(),
  );
  const marcas = estructura.brands;

  if (marcas.length === 0) {
    return (
      <>
        <h1>Importar la carta</h1>
        <Vacio
          titulo="Todavía no tienes ninguna marca"
          accion={{ href: '/panel/negocio', rotulo: 'Ir a tu negocio' }}
        >
          <p>La carta cuelga de una marca, así que ese es el primer paso.</p>
        </Vacio>
      </>
    );
  }

  const marca = marcas.find((m) => m.id === marcaPedida) ?? marcas[0]!;

  return (
    <>
      <h1>Importar la carta de {marca.name}</h1>
      <p className="panel__subtitulo">
        Pega las filas de tu Excel y mira qué va a pasar antes de aplicarlo.
        Nada se guarda hasta que lo confirmes.
      </p>

      {marcas.length > 1 ? (
        <p>
          {marcas.map((m) => (
            <Link
              key={m.id}
              href={`/panel/catalogo/importar?marca=${m.id}`}
              className="etiqueta"
              style={{ marginRight: 8 }}
            >
              {m.name}
            </Link>
          ))}
        </p>
      ) : null}

      <FormularioImportar brandId={marca.id} marca={marca.name} />

      <p className="pie-listado">
        <Link href="/panel/catalogo">Volver a la carta</Link>
      </p>
    </>
  );
}
