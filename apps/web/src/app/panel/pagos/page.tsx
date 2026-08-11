import { panel, type PasarelaDelPanel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { FormularioPasarela } from './formularios';

/**
 * Cobros en línea: la pasarela del negocio.
 *
 * `POST /payments/connections` existía desde F5 y **no había ninguna pantalla**,
 * así que conectar una pasarela exigía llamar a la API a mano. El resultado es
 * que ningún cliente podía cobrar en línea por su cuenta.
 *
 * Lo que esta pantalla resuelve además, y es lo que más se rompe en la
 * práctica: **la URL de aviso**. La pasarela confirma los pagos llamando a esa
 * dirección, y hasta ahora se devolvía UNA vez al crear la conexión — quien
 * cerrara la pantalla sin copiarla la perdía. Sin esa URL bien puesta, los
 * pedidos se quedan «pendiente de pago» para siempre y no hay ninguna pista de
 * por qué.
 */

export const dynamic = 'force-dynamic';

const NOMBRE_MEDIO: Record<string, string> = {
  card: 'Tarjeta',
  yape: 'Yape',
  plin: 'Plin',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
};

export default async function PagosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const pasarelas = await cargar('/panel/pagos', yaSeIntento, () =>
    panel.pasarelas(),
  );
  const dominios = await panel.dominios().catch(() => []);
  const base = dominios[0]?.host ?? 'tu-dominio.pe';

  return (
    <>
      <h1>Cobros en línea</h1>
      <p className="panel__subtitulo">
        Conecta tu cuenta de pasarela para que tus clientes puedan pagar al
        pedir. El dinero va directo a tu cuenta: nosotros no lo tocamos.
      </p>

      <h2>Lo que tienes conectado</h2>
      {pasarelas.length === 0 ? (
        <p className="panel__vacio">
          Nada todavía. Mientras tanto tus clientes solo pueden pagar al recibir
          el pedido.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Pasarela</th>
                <th>Medios</th>
                <th>Estado</th>
                <th>URL de aviso</th>
              </tr>
            </thead>
            <tbody>
              {pasarelas.map((p: PasarelaDelPanel) => (
                <tr key={p.id}>
                  <td>{p.provider}</td>
                  <td>
                    {p.methods.map((m) => NOMBRE_MEDIO[m] ?? m).join(', ')}
                  </td>
                  <td>{p.status === 'active' ? 'Activa' : p.status}</td>
                  <td>
                    <code>
                      https://{base}
                      {p.callbackPath}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Conectar una pasarela</h2>
      <FormularioPasarela dominio={base} />

      <h2>Sobre Apple Pay y Google Pay</h2>
      <p className="tarjeta__pie">
        No son pasarelas: son carteras que entregan un pago cifrado que{' '}
        <strong>tu pasarela</strong> cobra. Solo funcionan si tu pasarela las
        soporta y tienes las cuentas de Apple y de Google. Marcarlas aquí sin
        eso enseñaría un botón que no cobra, así que compruébalo antes con tu
        pasarela.
      </p>
      <p className="tarjeta__pie">
        Apple exige además un archivo suyo en cada dominio de tienda. Se carga
        en <strong>Negocio → dominios</strong>; sin él, el botón simplemente no
        aparece y no hay ningún error que lo explique.
      </p>
    </>
  );
}
