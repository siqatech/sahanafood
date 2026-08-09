import Link from 'next/link';
import { panel, PanelApiError } from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { lineasExternas } from '../lineas';
import { FormularioResolver, FormularioRechazar } from '../formularios';

/**
 * Resolver UNA excepción (RN-ORD-10).
 *
 * La pantalla pone una al lado de la otra las dos cosas que hacen falta para
 * decidir: **lo que mandó el canal** y **nuestra carta**. El payload crudo se
 * enseña entero y sin recortar, aunque debajo haya una lectura interpretada de
 * las líneas: el formato es de un tercero y puede cambiar sin avisar, así que
 * si la interpretación falla el operador tiene delante el original y puede
 * armar el pedido a mano. Esconderlo convertiría un fallo de lectura nuestro en
 * un pedido irresoluble.
 */

export default async function ExcepcionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const busqueda = await searchParams;
  const yaSeIntento = busqueda['intento'] === '1';
  const ruta = `/panel/excepciones/${id}`;

  let detalle;
  try {
    detalle = await cargar(ruta, yaSeIntento, () => panel.excepcion(id));
  } catch (error) {
    // Otra persona lo resolvió mientras este operador miraba la lista. Es lo
    // normal en un mostrador con dos encargados, y merece una frase y no una
    // pantalla de error.
    if (error instanceof PanelApiError) {
      return (
        <>
          <h1>Este pedido ya no está en revisión</h1>
          <p className="panel__vacio">
            {error.message} Puede que alguien lo haya resuelto o rechazado antes
            que tú. <Link href="/panel/excepciones">Vuelve a la bandeja</Link>.
          </p>
        </>
      );
    }
    throw error;
  }

  const [productos, conexiones, perfil] = await Promise.all([
    // La carta RESUELTA para el canal del pedido, no la carta entera: ofrecer
    // un plato sin precio en ese canal o pausado haría que resolver fallara
    // con el operador convencido de haberlo arreglado.
    cargar(ruta, yaSeIntento, () =>
      panel.vendibles(detalle.brandId, detalle.channel),
    ),
    // Las conexiones son opcionales: sin permiso de integraciones la pantalla
    // sigue sirviendo para resolver, solo que sin recordar el SKU.
    panel.conexiones().catch(() => []),
    panel.perfil().catch(() => null),
  ]);

  const lineas = lineasExternas(detalle.rawPayload);

  // Solo se ofrece recordar cuando hay UNA conexión candidata. Con dos, elegir
  // por nosotros metería el SKU en el conector equivocado y el canal quedaría
  // mapeado a una carta que no es la suya.
  const candidatas = conexiones.filter(
    (c) =>
      c.brandId === detalle.brandId &&
      c.channel === detalle.channel &&
      c.status === 'active',
  );
  const connectionId = candidatas.length === 1 ? candidatas[0]!.id : null;
  const puedeMapear =
    perfil?.permissions.some((p) => p === 'integrations.manage' || p === '*') ??
    false;

  return (
    <>
      <h1>Pedido #{detalle.orderNumber}</h1>
      <p className="panel__subtitulo">
        Entró por <strong>{detalle.channel}</strong>
        {detalle.externalRef
          ? ` con la referencia ${detalle.externalRef}`
          : ''}{' '}
        el{' '}
        {new Date(detalle.createdAt).toLocaleString('es-PE', {
          timeZone: 'America/Lima',
        })}
        .
      </p>

      {detalle.reason ? (
        <p className="panel__error">Por qué se apartó: {detalle.reason}</p>
      ) : null}

      {detalle.customerName || detalle.customerPhone ? (
        <p className="tarjeta__pie">
          Cliente: {detalle.customerName ?? 'sin nombre'}
          {detalle.customerPhone ? ` · ${detalle.customerPhone}` : ''}
        </p>
      ) : null}

      {productos.length === 0 ? (
        <p className="panel__vacio">
          No hay ningún plato vendible en <strong>{detalle.channel}</strong>,
          así que no hay a qué mapear. Puede que falten precios para ese canal o
          que esté todo pausado: se arregla en{' '}
          <Link href="/panel/catalogo">la carta</Link>.
        </p>
      ) : (
        <>
          <h2>A qué corresponde</h2>
          <FormularioResolver
            orderId={detalle.orderId}
            lineas={lineas}
            productos={productos}
            connectionId={connectionId}
            puedeMapear={puedeMapear}
          />
        </>
      )}

      <h2>Lo que llegó, sin tocar</h2>
      <p className="tarjeta__pie">
        Tal cual lo mandó el canal. Si la tabla de arriba no reconoció las
        líneas, están aquí.
      </p>
      <pre className="crudo">
        {JSON.stringify(detalle.rawPayload, null, 2) ?? 'sin payload'}
      </pre>

      <h2>Si no hay forma de resolverlo</h2>
      <p className="tarjeta__pie">
        Rechazarlo avisa al canal y cierra el pedido. El cliente deja de
        esperar, que es mejor que esperar sin respuesta.
      </p>
      <FormularioRechazar orderId={detalle.orderId} />

      <p style={{ marginTop: 24 }}>
        <Link href="/panel/excepciones">← Volver a la bandeja</Link>
      </p>
    </>
  );
}
