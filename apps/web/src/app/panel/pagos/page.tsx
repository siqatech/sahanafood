import { panel, type PasarelaDelPanel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import {
  FormularioPasarela,
  FormularioTarifa,
  FormularioLiquidacion,
} from './formularios';
import { Vacio } from '../vacio';
import { solesDeTexto } from '../caja/dinero';

/** Los canales por los que entra dinero y que, por tanto, tienen comisión. */
const CANALES = ['web', 'pos', 'rappi'];

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

  // Se degradan solos: quien entra a conectar una pasarela tiene que poder
  // hacerlo aunque la conciliación no cargue.
  const [tarifas, liquidaciones] = await Promise.all([
    panel.tarifas().catch(() => []),
    panel.liquidaciones().catch(() => []),
  ]);
  // Las pasarelas conectadas son las que pueden mandar un corte. Si no hay
  // ninguna, se ofrece la de referencia para no dejar el desplegable vacío.
  const proveedores =
    pasarelas.length > 0
      ? [...new Set(pasarelas.map((p: PasarelaDelPanel) => p.provider))]
      : ['culqi'];

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

      <h2>Comisiones pactadas</h2>
      <p className="panel__subtitulo">
        Lo que cobra la pasarela por canal. No es papeleo: sin esto la
        conciliación sabe si el bruto cuadra, pero no si te cobraron de más.
      </p>
      {tarifas.length === 0 ? (
        <p className="panel__error">
          Ninguna. Con las liquidaciones se podrá comprobar que el dinero llegó,
          pero no que la comisión sea la acordada.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Canal</th>
                <th>Pasarela</th>
                <th className="dinero">Comisión</th>
              </tr>
            </thead>
            <tbody>
              {tarifas.map((t) => (
                <tr key={t.id}>
                  <td>{t.channel}</td>
                  <td>{t.provider ?? 'cualquiera'}</td>
                  {/* Puntos básicos enteros a porcentaje: 350 → 3.5 %. */}
                  <td className="dinero">
                    {(t.percentBps / 100).toFixed(2)} %
                    {Number(t.fixedAmount) > 0
                      ? ` + S/ ${solesDeTexto(t.fixedAmount)}`
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormularioTarifa canales={CANALES} />

      <h2>Liquidaciones de la pasarela</h2>
      <p className="panel__subtitulo">
        La pasarela deposita por cortes y manda el detalle. Conciliarlo contra
        los cobros del sistema es lo único que responde a la pregunta que nadie
        contesta solo: <strong>¿me pagaron lo que dicen?</strong>
      </p>

      {liquidaciones.length === 0 ? (
        <Vacio titulo="Ningún corte conciliado todavía">
          <p>
            Sube el detalle del último depósito de tu pasarela y se comprobará
            cobro a cobro.
          </p>
        </Vacio>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Corte</th>
                <th>Periodo</th>
                <th className="dinero">Neto</th>
                <th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {liquidaciones.map((l) => (
                <tr
                  key={l.id}
                  className={
                    l.unmatchedLines > 0 ? 'ficha--revision' : undefined
                  }
                >
                  <td>
                    <strong>{l.externalRef}</strong>
                    <br />
                    <span className="tarjeta__pie">{l.provider}</span>
                  </td>
                  <td className="tarjeta__pie">
                    {l.periodStart} — {l.periodEnd}
                  </td>
                  <td className="dinero">S/ {solesDeTexto(l.netAmount)}</td>
                  <td>
                    {l.reconciledAt === null ? (
                      <span className="etiqueta">sin conciliar</span>
                    ) : (
                      <>
                        {/* El hallazgo serio va primero y en rojo: la pasarela
                            cobró algo que aquí no consta significa dinero
                            movido sin pedido detrás. */}
                        {l.unmatchedLines > 0 ? (
                          <p className="panel__error">
                            {l.unmatchedLines} cobro
                            {l.unmatchedLines === 1 ? '' : 's'} suyo
                            {l.unmatchedLines === 1 ? '' : 's'} que aquí no
                            consta{l.unmatchedLines === 1 ? '' : 'n'}
                          </p>
                        ) : null}
                        {l.missingLines > 0 ? (
                          <p className="tarjeta__pie">
                            {l.missingLines} cobro
                            {l.missingLines === 1 ? '' : 's'} nuestro
                            {l.missingLines === 1 ? '' : 's'} sin depositar
                          </p>
                        ) : null}
                        {l.unmatchedLines === 0 && l.missingLines === 0 ? (
                          <span className="etiqueta etiqueta--unido">
                            {l.matchedLines} cuadran
                          </span>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormularioLiquidacion proveedores={proveedores} />

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
