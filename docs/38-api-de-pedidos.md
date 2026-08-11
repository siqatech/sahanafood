# API de pedidos

> Para montar tu propia tienda —en WordPress, en React o en lo que sea— y que el
> pedido entre en la cocina del restaurante. Decisión y motivos en **ADR-0020**.

La tienda que damos nosotros usa exactamente esta API. No hay nada que ella
pueda hacer y tú no.

---

## 1. Lo primero: qué NO tienes que hacer

**No calcules precios.** Ni el subtotal, ni el IGV, ni el envío, ni el
descuento del cupón. Manda qué quiere el cliente y el servidor devuelve el
importe. No es una recomendación de estilo: tu web **no puede** proponer un
precio, y eso es lo que garantiza que lo que cobra la caja y lo que ve el
cliente sean la misma cifra.

**No guardes el carrito en el navegador.** Vive en nuestro servidor y se
identifica con un token. Así un producto que se agota mientras el cliente decide
aparece marcado en vez de desaparecer, y un pago fallido no borra la compra.

## 2. Tu clave

La consigues en el panel, en **Integración**. Empieza por `pk_` y **es pública**:
va en el HTML de tu web y no pasa nada.

Lo que abre, y nada más:

- Leer el catálogo de **tu** marca, que ya es público.
- Crear un carrito y operar sobre **ese** carrito.

Lo que no abre: consultar pedidos, ver clientes, ver ventas, cambiar precios.
Todo eso está detrás de la sesión del panel.

Va en cada llamada:

```
X-Sahana-Key: pk_a73633b82b75d374862108a912f0f254
```

## 3. Desde dónde puedes llamar

Desde el navegador, **solo desde los dominios que registraste** en el panel. Es
lo que impide que otra web monte tu carta y tus precios en su página.

Si tu web está en `polleria.pe`, regístralo primero. Mientras no esté
verificado, el navegador bloqueará las llamadas — y el error que verás en la
consola será de CORS, no nuestro.

Desde tu servidor (PHP, Node, lo que sea) no hay restricción de origen: CORS
protege al navegador, y una llamada de servidor no viene de una página.

## 4. Un pedido, de principio a fin

```bash
API=https://api.sahana.food/api/v1
K="X-Sahana-Key: pk_..."

# 1. Tu carta. Trae categorías, platos, precios ya calculados para el canal web,
#    y los grupos de modificadores con sus mínimos y máximos.
curl -s "$API/shop/catalog" -H "$K"

# 2. Un carrito. Guarda el token: es el pedido en curso de ESE cliente.
TOKEN=$(curl -s -X POST "$API/shop/carts" -H "$K" | jq -r .token)

# 3. Añadir. Los modificadores obligatorios se validan AQUÍ, no al confirmar:
#    enterarse de que faltaba elegir el tamaño con la tarjeta en la mano es
#    la peor forma de perder una venta.
curl -s -X POST "$API/shop/carts/$TOKEN/lines" -H "$K" \
  -H 'content-type: application/json' \
  -d '{"productId":"...","quantity":2,"modifierOptionIds":["..."]}'

# 4. La dirección. Decide el local que atiende y la tarifa de envío. Sin
#    cobertura NO devuelve error: devuelve el carrito en modo recojo.
curl -s -X POST "$API/shop/carts/$TOKEN/address" -H "$K" \
  -H 'content-type: application/json' \
  -d '{"address":"Av. Larco 100","lat":-12.125,"lng":-77.02}'

# 5. Quién pide.
curl -s -X POST "$API/shop/carts/$TOKEN/customer" -H "$K" \
  -H 'content-type: application/json' \
  -d '{"name":"Ana","phone":"+51987654321"}'

# 6. Confirmar. Devuelve el id del pedido.
curl -s -X POST "$API/shop/carts/$TOKEN/checkout" -H "$K"
```

## 5. `blockers`: qué falta para poder cobrar

Cada respuesta del carrito trae `blockers`. **Vacío significa que se puede
confirmar**; con algo dentro, el checkout va a fallar. Enséñalos en tu web en
vez de dejar que el cliente lo descubra al pulsar:

| Código | Qué significa |
|---|---|
| `NO_LINES` | El carrito está vacío. |
| `NO_ADDRESS` | Falta la dirección (o elegir recojo). |
| `NO_CUSTOMER` | Faltan nombre y teléfono. |
| `BELOW_MINIMUM` | No llega al mínimo de la zona de reparto. |
| `UNAVAILABLE_LINES` | Algo se agotó mientras el cliente decidía. |

## 6. Errores

Formato **Problem Details** (RFC 9457). El campo `detail` está escrito para que
puedas enseñárselo tal cual a tu cliente, en español:

```json
{
  "type": "https://sahana.food/errors/validation",
  "title": "Validación",
  "status": 422,
  "detail": "Elige una opción de \"Tamaño\"."
}
```

- **404** — la clave no vale, o el carrito no existe o caducó (72 h).
- **409** — el carrito ya se convirtió en pedido: no se cobra dos veces.
- **422** — falta algo o no cuadra. `detail` dice qué.

## 7. Idempotencia

Si tu web reintenta por una red mala, manda la misma cabecera
`Idempotency-Key` en el checkout. Con la misma clave, la respuesta es el mismo
pedido en vez de uno nuevo. Es lo que evita la comanda duplicada cuando el
cliente pulsa dos veces en el ascensor.

## 8. Lo que sigue siendo nuestro

- **El precio.** Siempre.
- **La disponibilidad.** Un plato pausado no se puede añadir, lo pinte tu web o
  no.
- **El comprobante.** Boleta o factura sale de nuestro lado, con su correlativo.
- **La cocina.** El pedido entra en el KDS y descuenta el stock igual que
  cualquier otro.

Tú pones el diseño, el idioma de tu marca y la experiencia. Nosotros ponemos que
el pedido llegue bien.
