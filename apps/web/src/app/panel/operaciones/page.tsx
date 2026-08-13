import Link from 'next/link';
import {
  panel,
  type PedidoDelPanel,
  type CartaMuerta,
  type DocumentoDelPanel,
  type CobroDelPanel,
  type PausaDeCanal,
  type ConexionDelPanel,
} from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { politicaPara, limiteDeRechazo } from './plazos';

/**
 * Los canales que se pueden cerrar a mano.
 *
 * Es una lista fija a propósito y no «los canales que han tenido pedidos»: hay
 * que poder cerrar un canal ANTES de que entre nada por él —es justo lo que se
 * hace cuando la cocina está desbordada— y una lista deducida de la actividad
 * no ofrecería el que aún no ha vendido hoy.
 */
const CANALES = ['web', 'pos', 'whatsapp', 'rappi', 'pedidosya'];
import { solesDeTexto } from '../caja/dinero';
import { Canal } from '../canal';
import {
  Cuenta,
  BotonesDeAceptacion,
  BotonReintentar,
  ControlDeCanal,
  Refresco,
} from './componentes';

/**
 * Centro de operaciones — la torre de control del turno (specs/ux/05).
 *
 * Responde UNA pregunta: **¿qué está entrando y qué necesita mi decisión
 * AHORA?** No es el KDS —eso es producción— ni el panel —eso es gestión—.
 *
 * ### Por qué esta pantalla no existía y por qué eso costaba dinero
 *
 * La spec la sitúa en F4 (básica) y F5 (completa), y ningún backlog la incluyó.
 * El efecto no era estético: **no había forma de aceptar un pedido desde
 * ninguna interfaz**. Los canales con aceptación manual dependían de que
 * alguien llamara al endpoint a mano, y a los diez minutos el barrido de
 * RN-ORD-04 los rechazaba solo. Es decir, todo pedido manual acababa
 * rechazado — no por decisión de nadie, sino por falta de un botón.
 *
 * ### Las tres columnas, y por qué en ese orden
 *
 * 1. **Por aceptar** — lo único con reloj. Va primero porque es lo único que se
 *    pierde por no mirarlo.
 * 2. **En curso** — para ver si la cocina va o se está atascando.
 * 3. **Problemas** — lo que ya falló y sigue esperando una decisión humana.
 *
 * Solo se enseña lo que tiene un dato real detrás. Una tarjeta de «POS offline
 * > 30 min» sin nada que la alimente es peor que su ausencia: enseña un verde
 * que nadie ha comprobado.
 */

/** Estados que significan «este pedido está vivo y en la casa». */
const EN_CURSO = [
  'accepted',
  'preparing',
  'ready',
  'packed',
  'dispatched',
] as const;

const ROTULO: Record<string, string> = {
  accepted: 'Aceptado',
  preparing: 'En preparación',
  ready: 'Listo',
  packed: 'Empacado',
  dispatched: 'En reparto',
};

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-PE', {
    timeZone: 'America/Lima',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function OperacionesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const ruta = '/panel/operaciones';

  const [porAceptar, excepciones, politicas, estructura] = await Promise.all([
    cargar(ruta, yaSeIntento, () => panel.pedidos({ status: 'received' })),
    cargar(ruta, yaSeIntento, () => panel.excepciones()),
    cargar(ruta, yaSeIntento, () => panel.politicasDeAceptacion()),
    cargar(ruta, yaSeIntento, () => panel.estructura()),
  ]);

  // En curso: una llamada por estado. Podría hacerse una sola sin filtro, pero
  // traería también los cerrados del día —cientos en hora punta— para tirar la
  // mayoría; con cinco filtradas se pide justo lo que se pinta.
  const enCurso = await Promise.all(
    EN_CURSO.map((estado) =>
      cargar(ruta, yaSeIntento, () =>
        panel.pedidos({ status: estado, limit: 50 }),
      ).then((lista) => [estado, lista] as const),
    ),
  );

  // La columna de problemas se degrada sola: quien no tenga permiso de
  // integraciones o de facturación ve el resto de la pantalla igual, en vez de
  // un error que le impide aceptar pedidos.
  const [cartasMuertas, rechazados, conexiones, devoluciones] =
    await Promise.all([
      panel.cartasMuertas().catch((): CartaMuerta[] => []),
      panel.documentos('rejected').catch((): DocumentoDelPanel[] => []),
      panel.conexiones().catch((): ConexionDelPanel[] => []),
      // Dinero de un cliente que sigue retenido porque la pasarela rechazó la
      // devolución y el sistema dejó de intentarlo. Es lo más urgente de esta
      // columna: hay alguien esperando que le devuelvan su plata.
      panel.devolucionesAtascadas().catch((): CobroDelPanel[] => []),
    ]);

  const degradadas = conexiones.filter((c) => c.status !== 'active');

  // Qué canales están cerrados AHORA. La saturación de cocina los pausa sola
  // (RN-KIT-04) y hasta ahora eso pasaba sin que nadie pudiera verlo ni
  // deshacerlo: en el local se vive como que las ventas se paran de golpe.
  const local = estructura.locations[0];
  const pausas = local
    ? await panel.pausas(local.id).catch((): PausaDeCanal[] => [])
    : [];
  const pausadas = new Map(pausas.map((p) => [p.channel, p]));

  const conPlazo = porAceptar.map((p: PedidoDelPanel) => ({
    pedido: p,
    limite: limiteDeRechazo(
      p.createdAt,
      politicaPara(politicas, p.brandId, p.channel),
    ),
  }));

  const problemas =
    cartasMuertas.length +
    rechazados.length +
    degradadas.length +
    devoluciones.length;

  return (
    <>
      {/* La pantalla se deja abierta en el local: se refresca sola cada 30 s. */}
      <Refresco segundos={30} />

      <h1>Operaciones</h1>
      <p className="panel__subtitulo">
        Qué está entrando y qué necesita una decisión ahora. Se actualiza sola
        cada 30 segundos.
      </p>

      {/* Los canales van ARRIBA de la torre: si un canal está cerrado, la
          columna «por aceptar» estará vacía por una razón que no es que no
          haya clientes. Sin esto, la pantalla dice «todo tranquilo» mientras
          el negocio no vende. */}
      <h2>
        Canales{' '}
        {pausas.length > 0 ? (
          <span className="etiqueta etiqueta--pausado">
            {pausas.length} cerrado{pausas.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </h2>
      {local ? (
        <div className="canales">
          {CANALES.map((canal) => {
            const pausa = pausadas.get(canal);
            return (
              <article
                key={canal}
                className={pausa ? 'ficha ficha--revision' : 'ficha'}
              >
                <p>
                  <strong>{canal}</strong>{' '}
                  {pausa ? (
                    <span className="etiqueta etiqueta--pausado">cerrado</span>
                  ) : (
                    <span className="etiqueta">abierto</span>
                  )}
                </p>
                {pausa?.reason ? (
                  <p className="tarjeta__pie">{pausa.reason}</p>
                ) : null}
                <ControlDeCanal
                  locationId={local.id}
                  channel={canal}
                  pausado={Boolean(pausa)}
                  {...(pausa ? { pausadoPor: pausa.pausedBy } : {})}
                />
              </article>
            );
          })}
        </div>
      ) : null}

      <div className="torre">
        {/* ------------------------------------------------ Por aceptar */}
        <section className="torre__columna">
          <h2>
            Por aceptar{' '}
            {conPlazo.length + excepciones.length > 0 ? (
              <span className="etiqueta etiqueta--sin-precio">
                {conPlazo.length + excepciones.length}
              </span>
            ) : null}
          </h2>

          {/* Las excepciones van ARRIBA del todo: un pedido que no se pudo
              traducir lleva más tiempo esperando que cualquiera de los que
              tienen reloj, y su cliente también. */}
          {excepciones.map((p) => (
            <article key={p.id} className="ficha ficha--revision">
              <p>
                <strong>#{p.orderNumber}</strong> <Canal canal={p.channel} />
              </p>
              <p className="tarjeta__pie">
                No se pudo traducir a nuestra carta · {hora(p.createdAt)}
              </p>
              <Link href={`/panel/excepciones/${p.id}`}>Resolver mapeo →</Link>
            </article>
          ))}

          {conPlazo.map(({ pedido, limite }) => (
            <article key={pedido.id} className="ficha">
              <p>
                <strong>#{pedido.orderNumber}</strong>{' '}
                <Canal canal={pedido.channel} /> <Cuenta limite={limite} />
              </p>
              <p className="tarjeta__pie">
                Entró a las {hora(pedido.createdAt)}
              </p>
              <BotonesDeAceptacion orderId={pedido.id} />
            </article>
          ))}

          {conPlazo.length + excepciones.length === 0 ? (
            <p className="panel__vacio">
              Nada esperando decisión. Los canales automáticos aceptan solos.
            </p>
          ) : null}
        </section>

        {/* --------------------------------------------------- En curso */}
        <section className="torre__columna">
          <h2>En curso</h2>
          {enCurso.every(([, lista]) => lista.length === 0) ? (
            <p className="panel__vacio">La casa está vacía ahora mismo.</p>
          ) : (
            enCurso.map(([estado, lista]) =>
              lista.length === 0 ? null : (
                <div key={estado}>
                  <p className="tarjeta__rotulo">
                    {ROTULO[estado]} · {lista.length}
                  </p>
                  {lista.map((p) => (
                    <p key={p.id} className="fila-compacta">
                      <strong>#{p.orderNumber}</strong>{' '}
                      <Canal canal={p.channel} />{' '}
                      <span className="tarjeta__pie">
                        desde {hora(p.createdAt)}
                      </span>
                    </p>
                  ))}
                </div>
              ),
            )
          )}
        </section>

        {/* -------------------------------------------------- Problemas */}
        <section className="torre__columna">
          <h2>
            Problemas{' '}
            {problemas > 0 ? (
              <span className="etiqueta etiqueta--pausado">{problemas}</span>
            ) : null}
          </h2>

          {cartasMuertas.map((c) => (
            <article key={c.id} className="ficha ficha--revision">
              <p>
                <strong>Webhook perdido</strong> · {c.provider}
              </p>
              {/* Es la ÚNICA forma en que este sistema puede perder un pedido:
                  el canal lo dio por entregado y aquí no existe. */}
              <p className="tarjeta__pie">
                {c.attempts} intentos · {c.lastError ?? 'sin detalle'}
              </p>
              <BotonReintentar id={c.id} />
            </article>
          ))}

          {rechazados.map((d) => (
            <article key={d.id} className="ficha ficha--revision">
              <p>
                <strong>Comprobante rechazado</strong> {d.number ?? ''}
              </p>
              <p className="tarjeta__pie">
                {d.rejectionReason ?? 'sin motivo devuelto'} · S/{' '}
                {solesDeTexto(d.total)}
              </p>
              <p className="tarjeta__pie">
                La venta no se pierde:{' '}
                <Link href="/panel/comprobantes">corrígelo y reenvíalo</Link>{' '}
                (RN-BIL-02).
              </p>
            </article>
          ))}

          {devoluciones.map((c) => (
            <article key={c.id} className="ficha ficha--revision">
              <p>
                <strong>Devolución atascada</strong> · S/{' '}
                {solesDeTexto(c.amount)}
              </p>
              <p className="tarjeta__pie">
                {c.refund?.reason ?? 'sin motivo'} · {c.refund?.attempts ?? 0}{' '}
                intentos
              </p>
              <p className="tarjeta__pie">
                {c.refund?.lastError ?? 'la pasarela no dio detalle'}. Hay que
                resolverlo con la pasarela a mano: el dinero del cliente sigue
                retenido.{' '}
                <Link href={`/panel/pedidos/${c.orderId}`}>Ver el pedido</Link>
              </p>
            </article>
          ))}

          {degradadas.map((c) => (
            <article key={c.id} className="ficha">
              <p>
                <strong>Conector {c.provider}</strong> · {c.channel}
              </p>
              <p className="tarjeta__pie">
                Estado: {c.status}. Mientras tanto ese canal ni recibe pedidos
                ni recibe cambios de carta.
              </p>
            </article>
          ))}

          {problemas === 0 ? (
            <p className="panel__vacio">Nada roto que requiera una decisión.</p>
          ) : null}
        </section>
      </div>
    </>
  );
}
