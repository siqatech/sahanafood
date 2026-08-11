import { panel, type PromocionDelPanel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { FormularioPromocion, Interruptores } from './formularios';

/**
 * Promociones y oferta de bienvenida.
 *
 * Los cupones existían en la base desde F5 y **no había forma de crear uno**:
 * solo aparecían si los sembraba la demo. Un descuento que exige acceso al
 * servidor no es una herramienta de marketing, es una nota para el programador.
 *
 * La oferta de BIENVENIDA es la que se anuncia sola a quien entra por primera
 * vez en la tienda. Es lo que convierte la tienda en algo que capta clientes en
 * vez de solo atender a los que ya te conocen: quien llega de un enlace no sabe
 * ningún código, así que un descuento que hay que teclear de memoria no lo usa
 * nadie.
 */

export const dynamic = 'force-dynamic';

function usos(p: PromocionDelPanel): string {
  if (p.maxUses === null) return `${p.usedCount} usos`;
  const quedan = p.maxUses - p.usedCount;
  return `${p.usedCount} de ${p.maxUses} · quedan ${quedan}`;
}

export default async function PromocionesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const [promociones, estructura] = await Promise.all([
    cargar('/panel/promociones', yaSeIntento, () => panel.promociones()),
    panel.estructura().catch(() => null),
  ]);

  const marcas = estructura?.brands ?? [];
  const bienvenida = promociones.find(
    (p: PromocionDelPanel) => p.isWelcome && p.active,
  );

  return (
    <>
      <h1>Promociones</h1>
      <p className="panel__subtitulo">
        Un descuento es dinero que dejas de cobrar a cambio de un cliente nuevo.
        Aquí decides cuánto, con qué mínimo y hasta cuántas veces.
      </p>

      <h2>Oferta de bienvenida</h2>
      {bienvenida ? (
        <p className="tarjeta__pie">
          Quien entra por primera vez a tu tienda ve un aviso con{' '}
          <strong>{bienvenida.code}</strong>: {bienvenida.label}. Lleva{' '}
          {usos(bienvenida)}.
        </p>
      ) : (
        <p className="panel__vacio">
          No tienes ninguna. Sin ella, tu tienda solo atiende a quien ya conoce
          tus códigos: quien llega desde un enlace no ve ninguna oferta y se va
          comparando precios.
        </p>
      )}

      <h2>Crear una promoción</h2>
      <FormularioPromocion marcas={marcas} />

      <h2>Las que tienes</h2>
      {promociones.length === 0 ? (
        <p className="panel__vacio">Todavía ninguna.</p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Código</th>
                <th>Qué descuenta</th>
                <th>Usos</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {promociones.map((p: PromocionDelPanel) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.code}</strong>
                    {p.isWelcome && p.active ? (
                      <>
                        {' '}
                        <span className="etiqueta">bienvenida</span>
                      </>
                    ) : null}
                  </td>
                  <td>{p.label}</td>
                  <td>
                    {usos(p)}
                    {p.maxUses !== null && p.usedCount >= p.maxUses ? (
                      <>
                        <br />
                        <span className="baja">Agotada</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {p.active ? (
                      'Activa'
                    ) : (
                      <span className="tarjeta__pie">Apagada</span>
                    )}
                  </td>
                  <td>
                    <Interruptores promocion={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
