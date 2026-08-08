# apps/web — Tienda web (Next.js)

Tienda multi-marca por dominio (spec 11, T5.08–T5.14). El panel de gestión
todavía no vive aquí.

## La regla que ordena todo

**El tenant sale del `Host` del visitante y de ningún otro sitio.** No hay
parámetro de marca, ni variable de entorno con un `tenantId`, ni query string.
Es lo que separa una tienda multi-marca de un buscador de catálogos ajenos.

En la práctica: el host viaja a la API en `x-forwarded-host`, **no** en `host`
— `fetch` de Node descarta `host` en silencio, y el síntoma es una página que
carga con «no hay ninguna tienda en este dominio» en vez de un error.

## Levantarla en local

```sh
make up                                   # Postgres, Redis
pnpm --filter @sahana/api migrate
pnpm --filter @sahana/api seed:shop       # crea la tienda demo en demo.localhost
pnpm --filter @sahana/api dev             # API en :3000
pnpm --filter @sahana/web dev             # tienda en :3001
```

Y se abre `http://demo.localhost:3001` — `demo.localhost` resuelve a 127.0.0.1
en los navegadores modernos, sin tocar `/etc/hosts`. Un `localhost:3001` pelado
da 404 a propósito: ese host no es de ninguna tienda.

La semilla deja el cupón `BIENVENIDO` (10 %, mínimo S/ 50) para probar tanto el
camino del descuento como el del mínimo.

## Presupuesto de rendimiento (T5.14)

```sh
pnpm --filter @sahana/web build
pnpm --filter @sahana/web budget
```

`budget` mide el **JS comprimido de primera carga** de catálogo, carrito y
checkout contra el límite de 200 KB de la spec, y **falla el build** si se pasa.
Corre en CI después de `build`.

La otra mitad de T5.14 —Lighthouse móvil ≥ 85— es medición humana: la
puntuación depende de la máquina, así que en CI o da falsos rojos o hay que
aflojar el umbral hasta que no signifique nada. Se registra con dispositivo y
red declarados en el gate de fase.

## Por qué casi no hay JavaScript

El presupuesto no se cumple optimizando al final: se cumple no metiendo código.
Todo es componente de servidor salvo tres formularios que necesitan enseñar un
error sin recargar, y esos **funcionan igual sin JavaScript** porque son
`<form>` de verdad contra acciones de servidor. Quien pide desde un móvil con
mala cobertura puede comprar mientras el bundle todavía no ha llegado.

Por eso no hay librería de UI, ni de estado, ni de fetching: cada una cabe de
sobra en el presupuesto ella sola.

## Lo que esta app NO hace

- **No calcula precios.** Ni sumas, ni porcentajes, ni IGV. Todos los importes
  llegan calculados de la API, que a su vez usa `@sahana/domain`. Aquí solo se
  formatean, con el mismo `Money` (`src/lib/money.ts`).
- **No guarda el carrito.** La cookie lleva un token; el carrito vive en el
  servidor. Es lo que hace que un pago fallido no se lleve la compra por delante.
- **No decide la cobertura.** La zona la resuelve el servidor con el polígono.

## Deuda conocida

No hay pruebas de navegador (DT-08). Los tres fallos que aparecieron al montar
esta app pasaron typecheck, lint y las 484 pruebas de la API, porque los tres
se manifiestan como una página que carga bien.
