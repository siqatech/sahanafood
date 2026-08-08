import { test, expect, type Page } from '@playwright/test';

/**
 * La tienda, en un navegador de verdad (ADR-0018, salda DT-08).
 *
 * Cada prueba corresponde a un fallo que **ocurrió**, no a uno imaginado. Los
 * tres de T5.08–T5.14 pasaron typecheck, lint y las pruebas de la API, y los
 * tres se veían igual: la página cargaba. Se comprueban por su **síntoma** —lo
 * que el cliente ve— y no por su causa técnica, porque la próxima vez la causa
 * será otra.
 */

const PRODUCTO = 'Pollo a la brasa entero';

/**
 * Pone un producto en el carrito desde la carta.
 *
 * El grupo «Tamaño» es obligatorio, así que hay que elegir: la validación vive
 * en el servidor y esto comprueba de paso que el formulario deja cumplirla.
 */
async function agregarAlCarrito(page: Page): Promise<void> {
  await page.goto('/');
  const tarjeta = page
    .locator('article.producto', { hasText: PRODUCTO })
    .first();
  await tarjeta.locator('input[type="radio"]').first().check();

  // Se espera a que la ACCIÓN DE SERVIDOR responda, no un tiempo fijo.
  //
  // Con JavaScript activo la acción viaja por `fetch` y `click()` vuelve en
  // cuanto despacha el evento: navegar a continuación adelanta al servidor y el
  // carrito sale vacío. Sin JavaScript no pasa —es un POST con redirección y
  // Playwright lo espera solo—, y esa asimetría es exactamente la clase de
  // intermitencia que ADR-0018 prohíbe tapar con un `waitForTimeout`.
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.request().isNavigationRequest() === false,
    ),
    tarjeta.getByRole('button', { name: /añadir al carrito/i }).click(),
  ]);

  await page.goto('/carrito');
  await expect(page.getByText(PRODUCTO)).toBeVisible();
}

test.describe('Tienda web en navegador', () => {
  test('EL CATÁLOGO SE VE, con los productos de la marca del dominio', async ({
    page,
  }) => {
    // Fallo 1: `fetch` de Node descarta en silencio la cabecera `host` —es una
    // cabecera prohibida y undici la sustituye por el destino real—, así que la
    // tienda pedía el catálogo sin decir de quién era y la página respondía
    // **200 con «no hay ninguna tienda en este dominio»**. Verde por fuera.
    await page.goto('/');

    await expect(
      page.getByText('No hay ninguna tienda en este dominio'),
      'el host del visitante no llegó a la API: la tienda no se resolvió',
    ).toHaveCount(0);

    await expect(page.getByText(PRODUCTO)).toBeVisible();
  });

  test('LOS PRECIOS SON PRECIOS, no NaN', async ({ page }) => {
    // Fallo 2: el JSON de `Money` no trae el campo que el componente asumía y
    // toda la carta se pintaba `S/ NaN`. La página cargaba, con 200, y ninguna
    // prueba de API podía verlo.
    await page.goto('/');

    const cuerpo = await page.locator('body').innerText();
    expect(
      cuerpo,
      'un precio sin formatear llega al cliente como NaN',
    ).not.toContain('NaN');

    // Y el formato completo, no solo «no es NaN»: símbolo y dos decimales.
    await expect(page.getByText(/S\/\s?\d+[.,]\d{2}/).first()).toBeVisible();
  });

  test('EL CHECKOUT CARGA y enseña el consentimiento EXACTO', async ({
    page,
  }) => {
    // Fallo 3: un archivo `'use server'` solo puede exportar funciones async.
    // Exportar desde ahí el texto de consentimiento tumbaba la página con un
    // 500 en tiempo de ejecución, sin pista en la compilación.
    await agregarAlCarrito(page);
    const respuesta = await page.goto('/checkout');
    expect(
      respuesta?.status(),
      'el checkout devolvió un error del servidor',
    ).toBeLessThan(500);

    // El texto tiene que estar A LA VISTA y ser el mismo que se guarda: la Ley
    // 29733 pide poder acreditar qué aceptó la persona, y dos copias del texto
    // se separan en la primera revisión legal.
    await expect(
      page.getByText(
        'Acepto recibir promociones y novedades de esta marca por WhatsApp o correo.',
      ),
    ).toBeVisible();
  });

  test('COMPRAR DE PRINCIPIO A FIN: carta → carrito → checkout → gracias', async ({
    page,
  }) => {
    await agregarAlCarrito(page);

    // El total lo calcula el servidor con `@sahana/domain`. Aquí solo se
    // comprueba que llega formateado.
    await expect(page.getByText(/S\/\s?\d+[.,]\d{2}/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page).toHaveURL(/checkout/);

    await page.getByLabel('Dirección').fill('Av. Larco 456, Miraflores');
    await page.getByRole('button', { name: /usar esta dirección/i }).click();

    await page.getByLabel('Nombre').fill('Rosa Quispe');
    await page.getByLabel('Teléfono').fill('+51987650001');
    await page.getByRole('button', { name: /confirmar pedido/i }).click();

    await expect(page).toHaveURL(/gracias/);
  });

  test('SIN JAVASCRIPT la tienda sigue vendiendo', async ({ browser }) => {
    // T5.14 promete que los formularios son `<form>` de verdad contra acciones
    // de servidor y funcionan sin JS. Hasta ahora esa promesa estaba escrita en
    // `docs/progress.md` y no la comprobaba nadie — que es como se convierte en
    // mentira sin que nadie lo note.
    const contexto = await browser.newContext({ javaScriptEnabled: false });
    const page = await contexto.newPage();

    try {
      await page.goto('/');
      // La carta se ve entera sin JS: es un componente de servidor.
      await expect(page.getByText(PRODUCTO)).toBeVisible();

      const tarjeta = page
        .locator('article.producto', { hasText: PRODUCTO })
        .first();
      await tarjeta.locator('input[type="radio"]').first().check();
      await tarjeta.getByRole('button', { name: /añadir al carrito/i }).click();

      await page.goto('/carrito');
      await expect(page.getByText(PRODUCTO)).toBeVisible();
    } finally {
      await contexto.close();
    }
  });

  test('un dominio SIN tienda no enseña la carta de otra', async ({
    browser,
  }) => {
    // El aislamiento por `Host` ya está probado contra la API; aquí se
    // comprueba lo que ve una persona, que es lo que decide si el fallo se
    // detecta: una carta ajena servida desde un dominio equivocado es
    // indistinguible de una tienda que funciona.
    const contexto = await browser.newContext();
    const page = await contexto.newPage();

    try {
      await page.goto('http://sin-tienda.localhost:3001/');
      await expect(
        page.getByText('No hay ninguna tienda en este dominio'),
      ).toBeVisible();
      await expect(page.getByText(PRODUCTO)).toHaveCount(0);
    } finally {
      await contexto.close();
    }
  });
});
