# ADR-0020 — La tienda es un consumidor más de la API de pedidos

| Campo | Valor |
|---|---|
| Estado | Propuesto |
| Fecha | 2026-08-11 |
| Decide | Propietario + Claude Code |
| Revisar si | (a) un cliente pide un dato del catálogo que la API pública no expone; (b) alguien necesita escribir en la API pública algo que no sea su propio carrito; (c) el volumen de una tienda de tercero obliga a caché de catálogo |

## Contexto

`apps/web` es hoy la tienda de Sahana Food, y por cómo está montada parece **la**
tienda. No lo es, ni debe serlo: un restaurante puede tener ya su web en
WordPress, o querer una hecha en React con su diseño, y lo que necesita de
nosotros no es una plantilla — es **que el pedido entre en su cocina**.

La API pública ya existe (`/api/v1/shop/*`) y nuestra tienda la consume por HTTP
como lo haría cualquiera. Pero está construida dando por hecho que **el
consumidor es nuestro servidor de Next**, y eso deja tres cosas rotas para un
tercero:

1. **La marca se resuelve por la cabecera `Host`.** Funciona cuando quien llama
   es un servidor que puede fijar esa cabecera —un WordPress llamando por PHP—,
   y **no funciona desde un navegador**: el `Host` de la petición es el nuestro,
   no el del cliente.
2. **No hay CORS.** Un JavaScript en `polleria.pe` que llame a nuestra API es
   bloqueado por el navegador antes de salir. Hoy, literalmente, una tienda de
   tercero en el navegador no puede pedir.
3. **No hay documentación.** Una API que nadie puede leer no es una API: es un
   detalle de implementación que resulta estar expuesto.

## Alternativas consideradas

**(a) Que cada cliente se integre por su servidor, con la cabecera `Host`.**
Cero trabajo por nuestra parte. Descartada: obliga a que toda tienda de tercero
tenga backend propio, y deja fuera el caso más común —una web estática o un
WordPress con JavaScript en el navegador—. Además convierte el `Host` en
credencial, y una cabecera que cualquiera puede escribir no lo es.

**(b) Dar a cada cliente una clave secreta de API, como la del panel.** Es lo
que hacen las integraciones servidor a servidor. Descartada para este caso: una
clave secreta **no se puede poner en un navegador**, que es justo donde tiene que
vivir el código de una tienda web. Poner un secreto en el HTML es publicarlo.

**(c) Un widget nuestro embebido (iframe o script).** Es lo que venden Flipdish y
Square. Descartada como única vía: resuelve el caso fácil y devuelve al cliente
al problema que quería evitar —el diseño lo ponemos nosotros—. Cabe más adelante
**encima** de la API, no en su lugar.

**(d) Clave PUBLICABLE por marca + CORS acotado a los dominios registrados.**
Es lo que hacen Stripe (`pk_`), Algolia y Mapbox para el mismo problema.

## Decisión

**(d).** La API pública de pedidos es un producto, y nuestra tienda es su primer
consumidor, no su dueño.

- **Clave publicable por marca** (`pk_…`), pensada para ir en el HTML. Identifica
  la marca y **no autoriza nada que no sea ya público**: leer el catálogo y
  operar sobre **el carrito que ella misma crea**. No lee pedidos ajenos, no
  toca precios, no ve clientes.
- **La cabecera `Host` sigue valiendo** para quien llame desde su servidor. Las
  dos vías resuelven la misma marca; la clave manda si vienen las dos.
- **CORS con lista blanca** derivada de `sto_domains`: solo los dominios que un
  cliente registró y verificó como suyos. Nunca `*` — un comodín convierte cada
  tienda en un catálogo que cualquier web puede montar en su página.
- **La clave se puede rotar y revocar** sin tocar el dominio ni el catálogo.

Lo que la clave publicable **no** abre, y hay que mantener así: consultar un
pedido por id, listar pedidos, ver clientes, ver importes agregados. Todo eso
vive detrás de la sesión del panel.

## Consecuencias

**Positivas**

- El cliente conserva su web y su marca; nosotros nos quedamos con lo que
  sabemos hacer, que es que el pedido llegue a la cocina con el precio correcto.
- Obliga a que la API pública sea **completa y estable**, que es la disciplina
  que evita que nuestra tienda acumule atajos por dentro.
- El cálculo de totales sigue siendo del servidor pase lo que pase: una tienda de
  tercero es, por construcción, una lista de deseos hasta que el servidor la
  valora.

**Negativas, y su mitigación**

- **Superficie pública mayor.** Se mitiga con lo que la clave NO permite (arriba)
  y con límite de peticiones por clave, porque el carrito es anónimo.
- **Compatibilidad.** Publicada la API, cambiarla rompe tiendas de clientes. Se
  mitiga con el versionado que ya existe (`/api/v1`) y con la regla de que un
  campo publicado no se quita dentro de la misma versión.
- **Soporte.** Un fallo en la web del cliente nos va a llegar como «no funciona
  su API». Se mitiga con documentación con ejemplos ejecutables y con mensajes de
  error que digan qué falta — el mismo criterio que el resto del sistema.
- **La clave es visible.** Es su naturaleza. Por eso el control real no es la
  clave sino el CORS y lo poco que autoriza: quien la copie solo puede hacer lo
  que ya podía haciendo desde la tienda pública del cliente.
