import type { Metadata } from 'next';

/**
 * La página para el desarrollador del cliente (ADR-0020).
 *
 * ADR-0020 dio tres motivos por los que una tienda de tercero no podía usar
 * nuestra API. Dos se arreglaron con código —la clave publicable y el CORS— y el
 * tercero era este: **no había documentación**. Una API que nadie puede leer no
 * es una API, es un detalle de implementación que resulta estar expuesto.
 *
 * Hasta ahora el panel remitía a `docs/38-api-de-pedidos.md`, que es un archivo
 * de NUESTRO repositorio: quien lo leía —el desarrollador que contrató el
 * restaurante— no podía abrirlo. Era el mismo callejón sin salida que el enlace
 * de seguimiento, con otra forma.
 *
 * Va fuera del grupo `(tienda)` a propósito: no lleva la marca de ningún
 * restaurante, porque no es de ninguno. Y fuera de `/panel`, porque quien la
 * necesita puede no tener cuenta.
 */

export const metadata: Metadata = {
  title: 'API de pedidos — Sahana Food',
  description:
    'Monta tu propia tienda y que el pedido entre en la cocina del restaurante.',
};

const EJEMPLO = `API=https://api.sahana.food/api/v1
K="X-Sahana-Key: pk_..."

# 1. Tu carta, con los precios ya calculados para el canal web.
curl "$API/shop/catalog" -H "$K"

# 2. Un carrito. Devuelve un token: guárdalo en el navegador de tu cliente.
curl -X POST "$API/shop/carts" -H "$K"

# 3. Lo que elija, con sus modificadores. La respuesta trae el total.
curl -X POST "$API/shop/carts/$TOKEN/lines" -H "$K" \\
  -H 'content-type: application/json' \\
  -d '{"productId":"...","quantity":1,"modifierOptionIds":["..."]}'

# 4. Dirección y datos, y el pedido entra en la cocina.
curl -X POST "$API/shop/carts/$TOKEN/checkout" -H "$K" \\
  -H 'content-type: application/json' -d '{"payment":"on_delivery"}'`;

export default function DesarrolladoresPage() {
  return (
    <main className="documento">
      <h1>API de pedidos</h1>
      <p className="entradilla">
        Para montar la tienda del restaurante donde quieras —WordPress, React,
        lo que uses— y que el pedido entre en su cocina. La tienda que damos
        nosotros usa exactamente esta API: no hay nada que ella pueda hacer y tú
        no.
      </p>

      <h2>Lo único que tienes que saber antes de empezar</h2>
      <p>
        <strong>No calcules precios.</strong> Ni el subtotal, ni el IGV, ni el
        envío, ni el descuento del cupón. Manda qué quiere el cliente y el
        servidor devuelve el importe. No es una recomendación de estilo: tu web{' '}
        <strong>no puede</strong> proponer un precio, y eso es lo que garantiza
        que lo que cobra la caja y lo que ve el cliente sean la misma cifra.
      </p>
      <p>
        <strong>No guardes el carrito en el navegador.</strong> Vive en nuestro
        servidor y se identifica con un token. Así un producto que se agota
        mientras el cliente decide aparece marcado en vez de desaparecer, y un
        pago fallido no borra la compra.
      </p>

      <h2>Tu clave</h2>
      <p>
        La consigue el dueño del restaurante en su panel, en{' '}
        <strong>Integración</strong>. Empieza por <code>pk_</code> y{' '}
        <strong>es pública</strong>: va en el HTML de tu web y no pasa nada.
      </p>
      <p>
        Lo que abre es leer el catálogo de esa marca —que ya es público— y
        operar sobre el carrito que ella misma crea. Lo que no abre: consultar
        pedidos, ver clientes, ver ventas ni cambiar precios. Todo eso vive
        detrás de la sesión del panel.
      </p>
      <p>
        Desde un navegador solo puedes llamar{' '}
        <strong>desde los dominios que el dueño registró</strong> en su panel.
        Es lo que impide que otra web monte su carta y sus precios en su página.
        Si tu web está en <code>polleria.pe</code>, que la registre primero;
        mientras no esté verificada verás un error de CORS en la consola.
      </p>

      <h2>Un pedido, de principio a fin</h2>
      <pre className="codigo">{EJEMPLO}</pre>

      <h2>Lo que devuelve cuando algo falta</h2>
      <p>
        El carrito trae siempre <code>blockers</code>: la lista de lo que impide
        cobrarlo, con su motivo. No adivines cuál es el siguiente paso —
        pregúntaselo al carrito y enseña ese texto.
      </p>
      <p>
        Los errores son Problem Details (RFC 9457): <code>title</code>,{' '}
        <code>detail</code> y un <code>code</code> estable con el que decidir en
        tu código. El <code>detail</code> está escrito para enseñárselo a una
        persona.
      </p>

      <h2>El manual completo</h2>
      <p>
        <a href="/manual-api.md">Manual de la API de pedidos</a> — con todos los
        endpoints, los <code>blockers</code>, la idempotencia y qué sigue siendo
        responsabilidad nuestra.
      </p>
    </main>
  );
}
