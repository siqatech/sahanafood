# La tienda: qué falta para que venda

> Contraste con las referencias que el propietario señaló —tao369, Ollie's,
> Square, Flipdish, Deliverect, Toast, Clover— y plan por fases. Escrito después
> de mirar la tienda en un móvil, no de leer el código.

## 1. Lo que la tienda es hoy

Una **página de pedido**: catálogo, carrito, checkout de invitado. Funciona,
cobra bien y funciona sin JavaScript. Lo que no es todavía es una **web de
restaurante**, que es la diferencia que separa las dos referencias que más le
gustan al propietario del resto.

## 2. Qué hacen las referencias

**tao369** (el más cercano a nuestro mercado):
- Banner de **«25 % en tu primer pedido en línea»** en la portada.
- Sección «NUESTRA HISTORIA»: el negocio se presenta antes de vender.
- Selector **recojo / delivery** y **elección de local** antes de la carta.
- Llamada a la acción: «Comienza tu pedido».

**Ollie's**:
- Hero con lema y una frase que sitúa al negocio («Feeding new yorkers since
  1989»).
- Sección «quién es Ollie»: la historia del fundador.
- Galería de fotos del local y de los platos.
- **Locales con dirección y teléfono**.

**Square, Flipdish, Deliverect, Toast, Clover** coinciden en tres argumentos:
descuento de primera compra para captar, marca propia del restaurante (no la
del proveedor), y menús largos que siguen siendo navegables.

## 3. Hecho

### La carta y el carrito (commit anterior)

Diagnóstico real: pulsar «Añadir» en un plato con opción obligatoria sacaba un
globo del navegador **en inglés** que se iba solo, y un añadido correcto no daba
**ninguna** señal. Añadir bien y añadir mal se veían igual.

Ahora: lista ojeable con foto y precio, ficha del plato como ruta propia,
confirmación al añadir, contador, barra fija con el total, navegación por
categorías y cantidades +/− en el carrito.

### La oferta de bienvenida

Lo que pidió el propietario, y lo que las cinco referencias comerciales ponen
primero. Estaba a medias: los cupones existían en la base **desde F5 y no había
forma de crear uno** — solo aparecían si los sembraba la demo. Un descuento que
exige acceso al servidor no es una herramienta de marketing.

Ahora hay pantalla `/panel/promociones`, la marca `is_welcome` con un índice que
impide tener dos a la vez, y el aviso en la tienda. Tres decisiones que importan:

- **El texto lo redacta el servidor.** Componer «10 %» en el navegador es cómo
  se llega a un escaparate que promete lo que la caja no aplica.
- **Un cupón caducado o agotado no se anuncia.** La consulta filtra por las
  mismas condiciones que valida el carrito.
- **Sale una vez.** Un anuncio que reaparece en cada visita es el motivo por el
  que la gente aprende a cerrar sin leer.

## 4. Lo que falta, por orden de valor

### 4.1 El aspecto de la tienda — **HECHO**

El propietario resolvió PA-12 señalando la pantalla de *Branding* de Deliverect:
nombre que se anuncia, lema, logo, imagen de portada y colores. Está en
`/panel/aspecto`, con vista previa que se actualiza al escribir — elegir un color
a ciegas y tener que abrir la tienda en otra pestaña es lo que hace que nadie
termine de configurarlo.

Va **por marca** y no por negocio: un tenant multimarca es el caso normal aquí,
y con los colores en el negocio las dos tiendas se verían iguales.

Los colores se validan como `#rrggbb` **en el servidor** y las imágenes exigen
`https://`. No es celo: ese valor acaba dentro de un atributo `style` que se
sirve a los clientes del restaurante, y aceptar texto libre sería dejar que
quien administra una marca decida cómo se ve la página. Hay una prueba
bloqueante.

Lo que sigue faltando de §4.1: la **portada como página aparte** —historia,
galería, `/` como inicio y la carta en `/carta`— que cambia las URL que los
clientes ya tengan guardadas.

### 4.1b La portada como web, no como carta — **necesita decisión**

Hoy `/` **es** la carta. Las referencias tienen portada con lema, historia,
fotos, horarios, locales y un botón «Comienza tu pedido» que lleva a la carta.

El obstáculo no es de diseño: **esos contenidos no existen como datos**. La
marca tiene nombre y poco más. Hace falta decidir qué puede editar el dueño
—lema, historia, foto de portada, redes— y eso es una tabla nueva y una pantalla
de panel. Sin la pantalla sería otro dato que nadie puede cambiar.

Pregunta abierta **PA-12**.

### 4.2 Horarios y locales en la tienda

`org_locations` y `org_schedules` existen y **la API pública no los expone**, así
que la tienda no puede decir a qué hora abre ni desde dónde reparte. Es la
pregunta que más se hace quien mira una web de restaurante y no necesita ningún
dato nuevo: solo una ruta.

### 4.3 Recojo o delivery antes de pedir

tao369 lo pregunta al entrar. Nosotros lo deducimos al escribir la dirección, ya
en el checkout: quien quería recoger llena una dirección para nada, y quien está
fuera de zona se entera al final.

### 4.4 Estado del pedido para el cliente

Existe `/seguimiento/:token` pero no se enseña al terminar la compra ni llega por
WhatsApp con un enlace. «¿Y ahora qué?» es la pregunta del minuto siguiente a
pagar.

### 4.5 Guía del panel

Para el dueño, no para el cliente. Hoy el panel tiene catorce pantallas y
ninguna primera vez guiada: qué hacer el día uno, qué es un canal, por qué
importa el food cost.

## 5. Lo que NO conviene copiar

- **Cuentas de cliente con contraseña.** tao369 tiene «Iniciar sesión»; nosotros
  vendemos como invitado a propósito (RN-STO-04). Una cuenta más es un motivo
  más para abandonar, y el historial se puede resolver por teléfono.
- **Galería de fotos del local en la carta.** Las fotos venden en la ficha del
  plato; en medio de la carta estorban el desplazamiento.
