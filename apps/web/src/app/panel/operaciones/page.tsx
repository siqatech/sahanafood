import Link from 'next/link';
import {
  panel,
  type PedidoDelPanel,
  type CartaMuerta,
  type DocumentoDelPanel,
  type ConexionDelPanel,
} from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { politicaPara, limiteDeRechazo } from './plazos';
import {
  Cuenta,
  BotonesDeAceptacion,
  BotonReintentar,
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

  const [porAceptar, excepciones, politicas] = await Promise.all([
    cargar(ruta, yaSeIntento, () => panel.pedidos({ status: 'received' })),
    cargar(ruta, yaSeIntento, () => panel.excepciones()),
    cargar(ruta, yaSeIntento, () => panel.politicasDeAceptacion()),
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
  const [cartasMuertas, rechazados, conexiones] = await Promise.all([
    panel.cartasMuertas().catch((): CartaMuerta[] => []),
    panel.documentos('rejected').catch((): DocumentoDelPanel[] => []),
    panel.conexiones().catch((): ConexionDelPanel[] => []),
  ]);

  const degradadas = conexiones.filter((c) => c.status !== 'active');

  const conPlazo = porAceptar.map((p: PedidoDelPanel) => ({
    pedido: p,
    limite: limiteDeRechazo(
      p.createdAt,
      politicaPara(politicas, p.brandId, p.channel),
    ),
  }));

  const problemas =
    cartasMuertas.length + rechazados.length + degradadas.length;

  return (
    <>
      {/* La pantalla se deja abierta en el local: se refresca sola cada 30 s. */}
      <Refresco segundos={30} />

      <h1>Operaciones</h1>
      <p className="panel__subtitulo">
        Qué está entrando y qué necesita una decisión ahora. Se actualiza sola
        cada 30 segundos.
      </p>

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
                <strong>#{p.orderNumber}</strong>{' '}
                <span className="etiqueta">{p.channel}</span>
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
                <span className="etiqueta">{pedido.channel}</span>{' '}
                <Cuenta limite={limite} />
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
                      <span className="etiqueta">{p.channel}</span>{' '}
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
                {d.rejectionReason ?? 'sin motivo devuelto'} · S/ {d.total}
              </p>
              <p className="tarjeta__pie">
                La venta no se pierde: hay que corregir y reenviar (RN-BIL-02).
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
