import Link from 'next/link';
import { shop, ApiError, type Seguimiento } from '../../../../lib/api';

/**
 * «¿Dónde está mi pedido?» (T5.16).
 *
 * La API de seguimiento existía entera —token público de ADR-0017, 48 horas de
 * vigencia, datos mínimos— y **no había ninguna página que la abriera**. El
 * panel emitía un token que no llevaba a ningún sitio: el enlace que se le
 * mandaba al cliente era, literalmente, una URL rota.
 *
 * Va en el grupo `(tienda)` para heredar la cabecera y los colores de la marca:
 * quien abre este enlace acaba de comprar, y una página blanca sin marca parece
 * de otro.
 *
 * Lo que NO se enseña, y es deliberado: la dirección, los teléfonos, el importe
 * y el detalle del pedido. Este enlace se reenvía por WhatsApp y acaba en
 * capturas; el servidor tampoco los manda.
 */

export const dynamic = 'force-dynamic';

const ROTULO: Record<string, { titulo: string; detalle: string }> = {
  pending: {
    titulo: 'Estamos preparando tu pedido',
    detalle: 'En cuanto salga de cocina te asignamos repartidor.',
  },
  assigned: {
    titulo: 'Tu pedido ya tiene repartidor',
    detalle: 'Está recogiéndolo en el local.',
  },
  picked_up: {
    titulo: 'Tu pedido va en camino',
    detalle: 'Sale del local hacia tu dirección.',
  },
  delivered: {
    titulo: '¡Entregado!',
    detalle: 'Que aproveche.',
  },
  failed: {
    titulo: 'No pudimos entregarlo',
    detalle: 'Te vamos a llamar para reprogramarlo.',
  },
  returned: {
    titulo: 'Tu pedido volvió al local',
    detalle: 'Te vamos a llamar para resolverlo.',
  },
};

/**
 * Los pasos, en orden, con etiqueta CORTA.
 *
 * Corta a propósito: el titular ya dice la frase entera, y repetirla cuatro
 * veces debajo convierte una barra de progreso —que se lee de un vistazo— en un
 * párrafo que hay que leer.
 */
const PASOS = [
  { estado: 'pending', rotulo: 'Preparando' },
  { estado: 'assigned', rotulo: 'Repartidor asignado' },
  { estado: 'picked_up', rotulo: 'En camino' },
  { estado: 'delivered', rotulo: 'Entregado' },
] as const;

function horaEstimada(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString('es-PE', {
    timeZone: 'America/Lima',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function SeguimientoPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let envio: Seguimiento;
  try {
    envio = await shop.seguimiento(token);
  } catch (error) {
    // Un token caducado y uno inventado se contestan IGUAL. Distinguirlos
    // convertiría esta página en una forma de averiguar qué tokens existieron.
    const noEncontrado = error instanceof ApiError && error.status === 404;
    return (
      <>
        <h1>Este enlace ya no sirve</h1>
        <p className="nota">
          {noEncontrado
            ? 'Los enlaces de seguimiento caducan a las 48 horas. Si tu pedido sigue en camino, escríbenos y te damos uno nuevo.'
            : 'No hemos podido consultar tu pedido. Vuelve a intentarlo en un momento.'}
        </p>
        <Link href="/">
          <button type="button">Ver la carta</button>
        </Link>
      </>
    );
  }

  const rotulo = ROTULO[envio.status] ?? {
    titulo: 'Tu pedido está en proceso',
    detalle: '',
  };
  const eta = horaEstimada(envio.etaAt);
  const indiceActual = PASOS.findIndex((p) => p.estado === envio.status);
  const fallido = envio.status === 'failed' || envio.status === 'returned';

  return (
    <>
      <h1>{rotulo.titulo}</h1>
      <p>{rotulo.detalle}</p>

      {/* La barra se salta cuando el envío se torció: pintar «entregado» en
          gris debajo de «no pudimos entregarlo» es enseñar un final que ya no
          va a pasar. */}
      {fallido ? null : (
        <ol className="pasos-envio" aria-label="Estado del pedido">
          {PASOS.map((paso, i) => (
            <li
              key={paso.estado}
              className={
                i <= indiceActual
                  ? 'paso-envio paso-envio--hecho'
                  : 'paso-envio'
              }
              aria-current={i === indiceActual ? 'step' : undefined}
            >
              {paso.rotulo}
            </li>
          ))}
        </ol>
      )}

      {eta ? (
        <p className="eta">
          Llega alrededor de las <strong>{eta}</strong>
        </p>
      ) : null}

      {envio.courierFirstName ? (
        <p className="nota">
          Lo lleva <strong>{envio.courierFirstName}</strong>.
        </p>
      ) : null}

      <Link href="/">
        <button type="button" className="secundario">
          Volver a la carta
        </button>
      </Link>
    </>
  );
}
