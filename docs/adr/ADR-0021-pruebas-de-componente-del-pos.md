# ADR-0021 — Pruebas de componente para el POS

| Campo | Valor |
|---|---|
| Estado | Propuesto |
| Fecha | 26 de agosto de 2026 |
| Decide | Añadir **jsdom + @testing-library/react** a `apps/pos`, sobre el vitest que ya está, para probar lo que el operador VE en las pantallas del POS y del KDS |
| Revisar si | (a) las pruebas empiezan a montar pantallas enteras con la API simulada en vez de componentes de presentación; (b) hace falta probar el modo offline real o el service worker, que sigue siendo otro problema (ADR-0018); (c) el tiempo de `pnpm --filter @sahana/pos test` pasa de 30 s |

## Contexto

CLAUDE.md prohíbe introducir bibliotecas sin ADR. Este es el ADR, igual que el
ADR-0018 lo fue para Playwright.

**La capa de presentación del POS no la mira nadie.** `apps/pos` tiene 25
pruebas y todas viven en `src/lib/`: la cola offline, el cálculo del ticket, el
arqueo, la composición de la comanda. Son buenas pruebas y cubren las reglas.
Lo que no cubren es **si lo que decide la regla llega a la pantalla**, y esa
distinción no es teórica en este proyecto: la lista de fallos de este tipo es
larga —el enlace de seguimiento que se emitía y no se enseñaba, los medios de
pago sin pantalla, la foto sin formulario, los alérgenos guardados y nunca
pintados—. Todos tenían la lógica probada.

**El caso que lo forzó tiene consecuencia física.** La banda de alérgenos del
KDS (docs/25) es la advertencia que separa «este plato lleva maní» de un cliente
en urgencias. Está implementada, el dato llega —hay pruebas de que se guarda, de
que sobrevive a un cambio de carta, de que llega a la vista del ticket y de que
sale en el papel— y el `if` que la pinta **no lo comprueba nada**. Es
exactamente el sitio donde no se puede aceptar «se ve al probar a mano».

**Playwright no sirve aquí, y no por pereza.** El ADR-0018 acotó Playwright a
`apps/web` y dejó anotado que la PWA del POS «es otro problema»: para llegar a
una pantalla del KDS hay que dar de alta un dispositivo, entrar con PIN, tener
tickets vivos y convivir con el service worker. Montar eso para comprobar que un
`div` aparece es caro de construir y, sobre todo, caro de mantener: cuanto más
larga la ruta hasta la aserción, más formas hay de que la prueba falle por algo
que no es lo que vigila.

## Decisión

Añadir a `apps/pos`, como dependencias **de desarrollo**:

- `jsdom` como entorno de vitest,
- `@testing-library/react` para montar y consultar,

y probar **componentes de presentación**: los que reciben datos por props y
devuelven lo que se ve, sin llamar a la API.

El entorno por defecto del proyecto **sigue siendo `node`**. jsdom se pide por
archivo, con `// @vitest-environment jsdom` en la cabecera: las pruebas de
`src/lib` no tocan el DOM y no tienen por qué pagar su coste ni recibir globales
de navegador que no deberían usar.

Para que eso sea posible, la tarjeta de comanda sale de `cocina.tsx` a su propio
componente. No es un efecto colateral del ADR: una pantalla que hace peticiones,
mantiene estado y además pinta cada detalle no se puede probar sin simular medio
mundo, y la parte que de verdad interesa —lo que se ve— no necesita nada de eso.

### Lo que este ADR NO decide

- **No** sustituye la pregunta del offline real ni la del service worker. Sigue
  abierta y es de otro tamaño.
- **No** autoriza montar pantallas enteras con la API simulada. Una prueba que
  simula `api.cola()` para llegar a una aserción sobre un `div` acaba probando
  el simulador. Si hace falta ese recorrido, es una prueba de navegador y
  entonces toca revisar el ADR-0018.

## Alternativas consideradas

**Extraer la decisión a `src/lib/` y probarla ahí.** Es lo que se ha hecho hasta
hoy y funciona para las reglas —de hecho `alergenosDe` vive en `@sahana/domain`
y tiene sus pruebas—, pero no puede responder a la pregunta que importa: no
detecta que la banda no se pinte. Una función que devuelve `['maní']` con nadie
que la llame pasa todas sus pruebas.

**Extender Playwright al POS.** Cubre más, cuesta bastante más y arrastra el
service worker y la sesión de dispositivo. Queda como el camino natural el día
que haga falta probar el offline de verdad, no para esto.

**No hacer nada.** Es la opción que deja sin prueba el único aviso del producto
cuyo fallo no se mide en dinero.

## Consecuencias

- Dos dependencias de desarrollo más en `apps/pos` y unos segundos de CI.
- Las pantallas del POS tenderán a partirse en «pantalla que orquesta» y
  «componente que pinta». Es la dirección correcta de todas formas.
- Hay que resistir la tentación de la prueba de pantalla completa. El apartado
  «lo que este ADR NO decide» está para releerlo cuando aparezca.
