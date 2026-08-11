import { panel, type ClaveDeTienda } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { FormularioClave, BotonRevocar } from './formularios';

/**
 * Conectar tu propia web (ADR-0020).
 *
 * La tienda que damos nosotros es **un consumidor más** de la API de pedidos, no
 * su dueña. Un restaurante que ya tiene su web en WordPress, o que quiere una
 * hecha a medida, no necesita nuestra plantilla: necesita que el pedido entre en
 * su cocina con el precio correcto.
 *
 * La clave es PÚBLICA por diseño —va en el HTML— y lo que la protege no es el
 * secreto sino lo poco que abre: leer el catálogo, que ya es público, y operar
 * sobre el carrito que ella misma crea. Más el CORS, acotado a los dominios que
 * el cliente registró. Por eso se enseña entera aquí: es su único uso.
 */

export const dynamic = 'force-dynamic';

function fecha(iso: string): string {
  return new Date(iso).toLocaleDateString('es-PE', {
    timeZone: 'America/Lima',
  });
}

export default async function IntegracionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const [claves, estructura, dominios] = await Promise.all([
    cargar('/panel/integracion', yaSeIntento, () => panel.clavesDeTienda()),
    panel.estructura().catch(() => null),
    panel.dominios().catch(() => []),
  ]);

  const marcas = estructura?.brands ?? [];
  const activas = claves.filter((c: ClaveDeTienda) => c.revokedAt === null);

  return (
    <>
      <h1>Conecta tu propia web</h1>
      <p className="panel__subtitulo">
        Si ya tienes web —en WordPress, en React o en lo que sea— no hace falta
        cambiarla: puede pedir contra nuestra API y el pedido entra en tu cocina
        igual que si viniera de la tienda que te damos nosotros.
      </p>

      <h2>Tus claves</h2>
      {activas.length === 0 ? (
        <p className="panel__vacio">
          Todavía ninguna. Crea una abajo y pégala en tu web.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Para</th>
                <th>Clave</th>
                <th>Creada</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {claves.map((c: ClaveDeTienda) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>
                    <code>{c.key}</code>
                    {c.revokedAt ? (
                      <>
                        <br />
                        <span className="baja">
                          Revocada el {fecha(c.revokedAt)}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>{fecha(c.createdAt)}</td>
                  <td>{c.revokedAt ? null : <BotonRevocar id={c.id} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Crear una clave</h2>
      <FormularioClave marcas={marcas} />

      <h2>Cómo se usa</h2>
      <p className="tarjeta__pie">
        Tu web manda la clave en la cabecera <code>X-Sahana-Key</code>. Con eso
        lee tu carta, abre un carrito, le añade lo que elija el cliente y
        confirma el pedido. Los precios y los totales los calcula siempre
        nuestro servidor: tu web no necesita —ni puede— proponer un importe.
      </p>
      <pre className="codigo">{`# La carta
curl https://api.sahana.food/api/v1/shop/catalog \\
  -H "X-Sahana-Key: pk_..."

# Un carrito, un plato y el pedido
curl -X POST https://api.sahana.food/api/v1/shop/carts \\
  -H "X-Sahana-Key: pk_..."`}</pre>
      {/* Antes esto ponía «está en docs/38-api-de-pedidos.md», que es un archivo
          de NUESTRO repositorio: quien tenía que leerlo —el desarrollador que
          contrató el restaurante— no podía abrirlo. */}
      <p className="tarjeta__pie">
        El manual completo, con el pedido de punta a punta, está en{' '}
        <a href="/desarrolladores" target="_blank" rel="noreferrer">
          sahana.food/desarrolladores
        </a>
        . Ese enlace se le puede pasar a quien haga la web.
      </p>

      <h2>Desde qué direcciones puede llamar</h2>
      <p className="tarjeta__pie">
        Por seguridad, un navegador solo puede llamarnos desde los dominios que
        registraste como tuyos. Si tu web vive en otra dirección, regístrala
        primero o las llamadas se bloquearán.
      </p>
      {dominios.length === 0 ? (
        <p className="panel__vacio">
          No tienes ningún dominio registrado, así que ninguna web propia podrá
          llamarnos desde el navegador todavía.
        </p>
      ) : (
        <ul>
          {dominios.map((d: { id: string; host: string; status: string }) => (
            <li key={d.id}>
              <code>{d.host}</code>{' '}
              {d.status === 'active' ? (
                'permitido'
              ) : (
                <span className="baja">sin verificar — todavía no permite</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
