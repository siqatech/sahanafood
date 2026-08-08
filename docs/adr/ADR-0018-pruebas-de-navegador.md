# ADR-0018 — Pruebas de navegador para la tienda web

| Campo | Valor |
|---|---|
| Estado | Propuesto |
| Fecha | 8 de agosto de 2026 |
| Decide | Adoptar **Playwright** como único runner de navegador del proyecto, acotado a `apps/web`, y hacerlo bloqueante en CI |
| Revisar si | (a) el tiempo de la suite pasa de 3 min en CI; (b) hace falta probar la PWA del POS en modo offline real, que es otro problema; (c) aparece un fallo de navegador que Playwright no puede reproducir |

## Contexto

CLAUDE.md prohíbe introducir bibliotecas centrales sin ADR. Este es el ADR.

**DT-08 no es una intuición, es un recuento.** Al montar `apps/web` (T5.08–T5.14)
aparecieron **tres fallos que ninguna prueba existente podía ver**, y los tres
pasaron typecheck, lint y las 484 pruebas de la API de entonces:

1. **`fetch` de Node descarta en silencio la cabecera `host`.** Es una cabecera
   prohibida: undici la sustituye por el destino real. La tienda pedía el
   catálogo sin decir de quién era, la API no encontraba tienda, y la página
   respondía **200 con «no hay ninguna tienda en este dominio»**.
2. **Los precios se pintaban `S/ NaN`**, porque el JSON de `Money` no trae el
   campo que el componente asumía.
3. **Un archivo `'use server'` no puede exportar una constante.** Exportar el
   texto de consentimiento desde ahí tumbaba el catálogo entero con un 500.

Comparten la forma exacta: **la página carga**. No hay excepción en el log del
servidor, no hay 500 en las métricas, y el contrato de la API —que sí está
cubierto de punta a punta— se cumple perfectamente. El fallo vive en el hueco
entre el servidor y el HTML que el cliente acaba viendo, y ese hueco no lo cubre
ninguna prueba de las que existen.

Sin runner de navegador, el cuarto fallo de esta familia llega a un cliente. Y la
tienda es la superficie que menos tolerancia tiene: es la que atiende sin sesión
y la que cobra.

## Alternativas consideradas

**1. No añadir nada; verificar a mano antes de cada release.** Es lo que se ha
hecho hasta ahora, y es lo que produjo los tres fallos: se verificó a mano y se
encontraron a mano, tarde. Una comprobación manual se salta el primer martes con
prisa, que es exactamente el día en que hay más cambios sin revisar.

**2. Pruebas de render sin navegador (Testing Library + jsdom).** Más rápidas y
sin binario que instalar. Pero jsdom **no ejecuta el servidor de Next**: los
componentes de servidor, las acciones de servidor y el propio `fetch` de undici
—que es donde vivía el fallo número 1— quedan fuera. Habría cubierto el `S/ NaN`
y ninguno de los otros dos. Cubrir un tercio de la evidencia y dar la sensación
de estar cubierto es peor que no cubrir nada.

**3. Cypress.** Capaz y conocido. Descartado por dos motivos concretos y no por
gusto: su modelo de ejecución dentro del navegador complica leer y afirmar sobre
cabeceras HTTP —que es la mitad del problema aquí, porque el tenant se resuelve
por `Host`—, y arrastra su propio runner y su propio lenguaje de aserciones,
cuando el repositorio ya tiene uno (Vitest) y una convención de pruebas escrita.

**4. Playwright.** Controla el navegador desde fuera, así que puede fijar
cabeceras, interceptar peticiones y **desactivar JavaScript**, que es lo que
permite comprobar la promesa concreta de T5.14: los formularios de la tienda son
`<form>` de verdad contra acciones de servidor y **funcionan sin JS**. Esa
afirmación está escrita en `docs/progress.md` y hoy no la comprueba nadie.

Y una razón práctica que no es menor: **el binario de Chromium ya está en el
entorno** (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), así que adoptarlo no
añade una descarga de 300 MB a cada instalación ni un paso de `install` que
falla detrás de un proxy.

## Decisión

**Playwright, acotado a `apps/web`, bloqueante en CI.**

Reglas de uso, para que no crezca hasta convertirse en la suite lenta que todo
el mundo acaba desactivando:

- **Solo lo que exige un navegador.** Reglas de negocio, precios, cobertura y
  aislamiento se prueban donde ya se prueban: dominio e integración. Si una
  prueba de navegador se puede escribir contra la API, va contra la API.
- **Un solo motor: Chromium.** Tres motores triplican el tiempo y la superficie
  de intermitencia; los fallos que esta suite existe para cazar no son de motor.
- **Contra el build real (`next start`), no contra `next dev`.** El fallo del
  `'use server'` se manifiesta distinto en desarrollo.
- **Datos por semilla, no por interfaz.** La tienda se siembra con
  `seed:shop`, que ya existe. Montar el escenario clicando multiplica el tiempo
  y hace que un fallo de la semilla parezca un fallo de la tienda.
- **Sin esperas por tiempo.** Nada de `waitForTimeout`: se espera por lo que la
  prueba afirma. Un `sleep` es una prueba intermitente con fecha de caducidad.

## Consecuencias

**Positivas.**

- Las tres clases de fallo de DT-08 quedan cubiertas por una prueba que corre en
  cada PR, y las tres se comprueban **por su síntoma real** —lo que el cliente
  ve— y no por su causa técnica, que la próxima vez será otra.
- La promesa de «funciona sin JavaScript» pasa a ser verificable. Hoy es una
  afirmación en un documento.
- **DT-08 queda saldada**, que era deuda vencida en el gate de F5.

**Negativas, y cómo se mitigan.**

- **CI más lento.** La suite necesita levantar Postgres, la API y Next. Se mitiga
  con un único job que reutiliza el build que ya se hace, un solo motor y un
  número de pruebas deliberadamente pequeño. Disparador de revisión: 3 minutos.
- **Riesgo de intermitencia**, que es como mueren las suites de navegador. Se
  mitiga con la regla de no esperar por tiempo y con datos sembrados en vez de
  construidos por interfaz. Una prueba intermitente **se arregla o se borra en
  la misma semana**: dejarla en rojo enseña a ignorar el job entero, que es
  exactamente lo que pasó con el gate de formato en F5.
- **Una dependencia más que mantener.** Acotada a `apps/web` y a
  `devDependencies`: no entra en ninguna imagen de producción.

**Lo que este ADR NO decide.** Las pruebas de la PWA del POS en modo offline real
(ADR-0008) son otro problema —service worker, IndexedDB, cortes de red— y tienen
su propia cobertura desde T4.20–T4.22. Si algún día se quieren en navegador, será
otra decisión con su propio ADR.
