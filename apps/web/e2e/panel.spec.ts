import { test, expect, type Page } from '@playwright/test';

/**
 * El panel de gestión, en un navegador de verdad (specs/ux/03, salda DT-09).
 *
 * Se prueba aquí y no contra la API por la razón de ADR-0018: lo que puede
 * fallar en un panel **sin que la API se entere** es precisamente lo que no se
 * ve desde la API — que la sesión no persista entre pantallas, que la
 * navegación lleve a la tienda en vez de al panel, que el precio que se guarda
 * no sea el que se escribió.
 *
 * La sesión es cookie `httpOnly` puesta por el servidor de Next, así que solo
 * un navegador con su tarro de cookies ejercita el camino real.
 */

const EMAIL = 'demo-tienda@sahana.test';
const PASSWORD = 'password-demo-tienda-1';

async function entrar(page: Page): Promise<void> {
  await page.goto('/panel/entrar');
  await page.getByLabel('Correo').fill(EMAIL);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/panel(\?|$)/),
    page.getByRole('button', { name: /entrar/i }).click(),
  ]);
}

test.describe('Panel de gestión en navegador', () => {
  test('SIN SESIÓN no se entra: el panel manda a la pantalla de acceso', async ({
    page,
  }) => {
    // Es la prueba que decide si el panel sirve para algo: si una pantalla de
    // gestión se pintara sin sesión, todo lo demás daría igual.
    await page.goto('/panel');
    await expect(page).toHaveURL(/\/panel\/entrar/);
    await expect(
      page.getByRole('heading', { name: /entrar al panel/i }),
    ).toBeVisible();

    // Y sin sesión no se enseña la navegación: tres enlaces que llevan todos a
    // la misma pantalla de acceso hacen dudar de si la contraseña falló.
    await expect(
      page.getByRole('link', { name: 'Carta', exact: true }),
    ).toHaveCount(0);
  });

  test('CON CREDENCIALES MALAS no dice cuál de las dos está mal', async ({
    page,
  }) => {
    await page.goto('/panel/entrar');
    await page.getByLabel('Correo').fill('no-existe@sahana.test');
    await page.getByLabel('Contraseña').fill('lo-que-sea-1234');
    await page.getByRole('button', { name: /entrar/i }).click();
    // «Usuario no encontrado» le diría a quien prueba qué correos existen.
    await expect(
      page.getByText(/correo o contraseña incorrectos/i),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/panel\/entrar/);
  });

  test('LA PORTADA responde «¿cómo vamos hoy?» y compara con la semana pasada', async ({
    page,
  }) => {
    await entrar(page);
    await expect(page.getByRole('heading', { name: 'Hoy' })).toBeVisible();
    await expect(page.getByText('Ventas', { exact: true })).toBeVisible();
    await expect(page.getByText('Ticket promedio')).toBeVisible();
    await expect(page.getByText('En marcha ahora')).toBeVisible();
    // El día comparado se dice en pantalla: un número sin con qué compararlo no
    // sirve para decidir nada.
    await expect(
      page.getByText(/comparado con \d{4}-\d{2}-\d{2}/),
    ).toBeVisible();
  });

  test('LA CARTA enseña lo que la tienda oculta y deja cambiar un precio', async ({
    page,
  }) => {
    await entrar(page);
    await page.getByRole('link', { name: 'Carta', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: /^Carta de / }),
    ).toBeVisible();

    const fila = page
      .locator('tbody tr')
      .filter({ hasText: 'Pollo a la brasa entero' })
      .first();
    await expect(fila).toBeVisible();

    // Columna «Tienda web»: se cambia el precio y se comprueba que el valor
    // GUARDADO es el que se escribió, releyendo la página. Comprobar solo que
    // el campo lo muestra no probaría nada — lo muestra porque lo escribimos.
    const campo = fila.getByLabel('Precio en web');
    await campo.fill('61.50');
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.request().isNavigationRequest() === false,
      ),
      fila.getByRole('button', { name: 'Guardar' }).nth(1).click(),
    ]);

    await page.reload();
    const filaTrasRecargar = page
      .locator('tbody tr')
      .filter({ hasText: 'Pollo a la brasa entero' })
      .first();
    await expect(filaTrasRecargar.getByLabel('Precio en web')).toHaveValue(
      '61.50',
    );

    // LA COMPROBACIÓN QUE IMPORTA: lo que el dueño escribe es lo que el cliente
    // ve. Un panel que guarda en una tabla que la tienda no lee no es un panel,
    // es un formulario bonito.
    await page.goto('/');
    const enLaTienda = page
      .locator('article.producto', { hasText: 'Pollo a la brasa entero' })
      .first();
    await expect(enLaTienda).toContainText('S/ 61.50');
  });

  test('UN PRECIO MAL ESCRITO se rechaza con un motivo, no con un 500', async ({
    page,
  }) => {
    await entrar(page);
    await page.goto('/panel/catalogo');
    const fila = page
      .locator('tbody tr')
      .filter({ hasText: 'Pollo a la brasa entero' })
      .first();
    await fila.getByLabel('Precio en web').fill('S/ 61,50 soles');
    await fila.getByRole('button', { name: 'Guardar' }).nth(1).click();
    await expect(page.getByText(/no es un precio/i)).toBeVisible();
  });

  test('EL NEGOCIO se lee, y dice claramente lo que todavía no se puede hacer aquí', async ({
    page,
  }) => {
    await entrar(page);
    await page.getByRole('link', { name: 'Negocio', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: /tu negocio/i }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Marcas' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Locales' })).toBeVisible();
    // Un panel que ofreciera un botón para cada cosa y fallara en la mitad
    // sería peor que uno que dice dónde está el límite.
    await expect(
      page.getByText(/Zonas de reparto, horarios, cocinas y estaciones/),
    ).toBeVisible();
  });

  test('SALIR cierra de verdad: volver al panel pide la contraseña otra vez', async ({
    page,
  }) => {
    await entrar(page);
    await Promise.all([
      page.waitForURL(/\/panel\/entrar/),
      page.getByRole('button', { name: 'Salir' }).click(),
    ]);
    // Y no basta con que redirija: la sesión tiene que haber muerto.
    await page.goto('/panel/catalogo');
    await expect(page).toHaveURL(/\/panel\/entrar/);
  });

  test('LA TIENDA sigue siendo la tienda: el panel no le puso su cabecera', async ({
    page,
  }) => {
    // El panel vive en el mismo `apps/web` que la tienda. Al separarlos en
    // grupos de rutas, lo que puede romperse en silencio es la tienda: que
    // pierda su cabecera, o que herede la del panel.
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Carrito' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sahana Food' })).toHaveCount(
      0,
    );
  });
});
