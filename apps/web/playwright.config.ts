import { defineConfig, devices } from '@playwright/test';

/**
 * Pruebas de navegador de la tienda (ADR-0018, salda DT-08).
 *
 * Existen porque tres fallos reales de T5.08–T5.14 pasaron typecheck, lint y
 * las 484 pruebas de la API, y los tres se manifestaban igual: **la página
 * carga**. El contrato de la API se cumplía perfectamente; lo que estaba roto
 * era lo que el cliente acababa viendo.
 *
 * Reglas de ADR-0018, para que esta suite no se convierta en la lenta que
 * todo el mundo acaba desactivando:
 *
 *  · **Solo lo que exige un navegador.** Si se puede escribir contra la API, va
 *    contra la API.
 *  · **Un solo motor.** Tres triplican el tiempo y la intermitencia, y los
 *    fallos que esto caza no son de motor.
 *  · **Contra el build real**, no contra `next dev`: el fallo del `'use server'`
 *    se manifestaba distinto en desarrollo.
 *  · **Sin esperas por tiempo.** Se espera por lo que la prueba afirma.
 */

/**
 * El host ES el escenario.
 *
 * La tienda resuelve el tenant por `Host` y por nada más, así que `localhost`
 * no vale: hay que entrar por un nombre que la semilla haya registrado como
 * dominio verificado. `demo.localhost` resuelve a 127.0.0.1 en los navegadores
 * modernos sin tocar `/etc/hosts`, que es justo lo que hace posible probar el
 * enrutado por dominio en una máquina sin DNS.
 */
export const SHOP_HOST = process.env['SHOP_HOST'] ?? 'demo.localhost:3001';
const BASE_URL = `http://${SHOP_HOST}`;

export default defineConfig({
  testDir: './e2e',
  // Sin paralelismo: todas comparten la misma tienda sembrada y el mismo
  // carrito de servidor. Repartirlas entre workers haría que una vaciara el
  // carrito de otra, y el fallo parecería de la tienda.
  workers: 1,
  fullyParallel: false,
  // Un reintento en CI. Más que eso esconde intermitencia en vez de arreglarla,
  // y ADR-0018 dice que una prueba intermitente se arregla o se borra.
  retries: process.env['CI'] ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? 'line' : 'list',

  use: {
    baseURL: BASE_URL,
    // La traza solo del reintento: guardarla siempre engorda el artefacto de
    // CI sin que nadie la mire cuando todo va bien.
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // En CI el navegador lo instala `playwright install chromium` y esto
        // se queda vacío. `PLAYWRIGHT_CHROMIUM_PATH` existe para entornos que
        // ya traen un Chromium propio —contenedores de desarrollo, imágenes
        // corporativas— donde volver a descargar 300 MB por cada ejecución no
        // tiene sentido y a veces ni siquiera es posible detrás de un proxy.
        ...(process.env['PLAYWRIGHT_CHROMIUM_PATH']
          ? {
              launchOptions: {
                executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'],
              },
            }
          : {}),
      },
    },
  ],

  /**
   * El servidor de la tienda, contra el build.
   *
   * La API se levanta fuera (`make e2e-web` o el job de CI): son dos procesos
   * con requisitos distintos —la API necesita Postgres migrado y la semilla
   * aplicada— y meterlos aquí escondería el orden real detrás de una promesa
   * de Playwright.
   */
  webServer: {
    command: 'pnpm start',
    // La sonda va por IP y NO por `demo.localhost`: el navegador resuelve
    // cualquier `*.localhost` a 127.0.0.1 por especificación, pero **Node no**
    // —usa el resolvedor del sistema—, así que la comprobación de arranque
    // fallaba y Playwright intentaba levantar un servidor que ya estaba vivo.
    url: 'http://127.0.0.1:3001',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    env: {
      SAHANA_API_URL: process.env['SAHANA_API_URL'] ?? 'http://localhost:3000',
    },
  },
});
