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
/**
 * Pone el plato con opciones en el carrito, pasando por su ficha.
 *
 * Refleja el flujo real desde que la carta dejó de traer los modificadores
 * dentro: la tarjeta lleva a la ficha, allí se elige y allí se añade.
 */
async function agregarAlCarrito(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .locator('li.plato', { hasText: PRODUCTO })
    .first()
    .getByRole('link', { name: /elegir opciones/i })
    .click();

  await page.locator('.opcion input').first().check();
  await page.locator('button.boton-principal').click();
  // La confirmación es la señal de que la línea entró: esperar a que aparezca
  // evita adelantar a la acción de servidor, que es de donde salían las
  // intermitencias que ADR-0018 prohíbe tapar con un `waitForTimeout`.
  await expect(page.locator('.confirmacion')).toBeVisible();

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

    await page.getByRole('link', { name: /continuar con la entrega/i }).click();
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

      // Y se puede comprar: la ficha del plato es una RUTA, no una ventana
      // que dependa de JavaScript, y el formulario postea de verdad.
      await page
        .locator('li.plato', { hasText: PRODUCTO })
        .first()
        .getByRole('link', { name: /elegir opciones/i })
        .click();
      await page.locator('.opcion input').first().check();
      await page.locator('button.boton-principal').click();

      await page.goto('/carrito');
      await expect(page.getByText(PRODUCTO)).toBeVisible();
    } finally {
      await contexto.close();
    }
  });

  test('AÑADIR SE NOTA: confirmación, contador y barra con el total', async ({
    page,
  }) => {
    // El fallo por el que se rehízo esta pantalla. Añadir devolvía `{}` en
    // silencio y el enlace del carrito no llevaba número, así que un añadido
    // CORRECTO se veía igual que uno fallido: la página se quedaba como estaba.
    // De ahí salía «el carrito no funciona» cuando el carrito sí había
    // recibido el plato.
    await page.goto('/');
    await expect(page.locator('.barra-carrito')).toHaveCount(0);

    await page
      .locator('li.plato', { hasText: 'Chicha morada' })
      .first()
      .getByRole('button', { name: /^añadir$/i })
      .click();

    await expect(page.locator('.confirmacion')).toContainText('Chicha morada');
    await expect(page.locator('.contador')).toHaveText('1');
    await expect(page.locator('.barra-carrito')).toContainText('S/ 10.00');
  });

  test('FALTA ELEGIR se dice en español y en la página, no en un globo', async ({
    page,
  }) => {
    // Antes lo resolvía el `required` del navegador: un globo del sistema en
    // INGLÉS —«Please select one of these options»— que se va solo a los pocos
    // segundos. Pulsabas «Añadir», no pasaba nada visible y el carrito seguía
    // vacío.
    await page.goto('/');
    await page
      .locator('li.plato', { hasText: PRODUCTO })
      .first()
      .getByRole('link', { name: /elegir opciones/i })
      .click();

    await page.locator('button.boton-principal').click();

    const alerta = page.locator('.alerta');
    await expect(alerta).toBeVisible();
    await expect(alerta).toContainText('Elige una opción');
    await expect(alerta).toContainText('Tamaño');
    // Y nada entró al carrito.
    await expect(page.locator('.contador')).toHaveCount(0);
  });

  test('EL PRECIO SUBE al elegir, antes de decidir', async ({ page }) => {
    // Ver el total antes de pulsar es lo que evita la sorpresa al abrir el
    // carrito.
    //
    // Los importes se leen de la página y se comparan ENTRE SÍ, sin cifras
    // fijas: el precio de este plato lo cambia otra prueba de esta misma
    // suite, y una expectativa de «S/ 32.00» convierte esto en una prueba que
    // falla según el orden en que corran. Lo que hay que demostrar es que
    // «Grande» suma 5 y que la segunda unidad dobla, no cuánto vale el pollo.
    await page.goto('/');
    await page
      .locator('li.plato', { hasText: PRODUCTO })
      .first()
      .getByRole('link', { name: /elegir opciones/i })
      .click();

    const boton = page.locator('button.boton-principal');
    const soles = async (): Promise<number> => {
      const texto = await boton.innerText();
      return Number(/S\/\s?([\d.]+)/.exec(texto)![1]);
    };

    const base = await soles();
    expect(base).toBeGreaterThan(0);

    await page.getByText('Grande').click();
    await expect(boton).not.toContainText(`S/ ${base.toFixed(2)}`);
    expect(await soles()).toBeCloseTo(base + 5, 2);

    await page.getByRole('button', { name: 'Añadir uno' }).click();
    await expect(boton).toContainText('·');
    expect(await soles()).toBeCloseTo((base + 5) * 2, 2);
  });

  test('LA CANTIDAD SE CAMBIA en el carrito, sin rehacer la línea', async ({
    page,
  }) => {
    // Era la operación que faltaba: solo se podía quitar la línea entera, así
    // que querer dos obligaba a volver a la carta y elegir otra vez todas las
    // opciones.
    await agregarAlCarrito(page);

    const linea = page.locator('li.linea', { hasText: PRODUCTO });
    await expect(linea.locator('.paso__valor')).toHaveText('1');

    const total = async (): Promise<number> => {
      const texto = await linea.locator('.linea__total').innerText();
      return Number(/S\/\s?([\d.]+)/.exec(texto)![1]);
    };
    const uno = await total();

    await linea.getByRole('button', { name: 'Añadir uno' }).click();
    await expect(linea.locator('.paso__valor')).toHaveText('2');
    // El doble, sin fijar la cifra: el precio de este plato lo cambia otra
    // prueba de la suite.
    expect(await total()).toBeCloseTo(uno * 2, 2);

    // En uno, el «−» se convierte en «Quitar»: un botón apagado no dice cómo
    // deshacerse de algo.
    await linea.getByRole('button', { name: 'Quitar uno' }).click();
    await expect(linea.locator('.paso__valor')).toHaveText('1');
    await expect(
      linea.getByRole('button', { name: 'Quitar del pedido' }),
    ).toBeVisible();
  });

  test('LA OFERTA DE BIENVENIDA sale una vez y no vuelve', async ({
    browser,
  }) => {
    // Quien llega de un enlace no conoce ningún código: si el descuento de
    // primera compra no se anuncia solo, no lo usa nadie.
    //
    // Va en contexto propio para empezar sin almacenamiento, que es lo que
    // define «primera visita».
    const contexto = await browser.newContext();
    const page = await contexto.newPage();
    try {
      await page.goto('/');

      const aviso = page.locator('.bienvenida');
      await expect(aviso).toBeVisible({ timeout: 10000 });
      await expect(aviso).toContainText('BIENVENIDO');
      // El texto lo redacta el servidor a partir del cupón real: 10 % con
      // mínimo de 50. Si la tienda lo compusiera por su cuenta, el escaparate
      // podría prometer algo que la caja no aplica.
      await expect(aviso).toContainText('10 %');
      await expect(aviso).toContainText('S/ 50.00');

      // Y no bloquea: se cierra y se puede pedir.
      await page.getByRole('button', { name: /ver la carta/i }).click();
      await expect(aviso).toHaveCount(0);

      // La segunda visita ya no lo enseña. Un anuncio que reaparece en cada
      // carga es el motivo por el que la gente aprende a cerrar sin leer.
      await page.goto('/');
      await page.waitForTimeout(2000);
      await expect(page.locator('.bienvenida')).toHaveCount(0);
    } finally {
      await contexto.close();
    }
  });

  test('LOS MEDIOS DE PAGO son los del negocio, y las carteras las filtra el navegador', async ({
    page,
  }) => {
    // La semilla conecta Culqi con tarjeta, Yape y las dos carteras. Sin este
    // paso el checkout enseñaba SIEMPRE lo mismo —contra entrega y nada más—
    // aunque el negocio tuviera pasarela: la tienda nunca leía `payment` del
    // contexto ni mandaba el medio elegido.
    await agregarAlCarrito(page);
    await page.goto('/checkout');

    const medios = page.locator('.medios');
    await expect(medios).toContainText('Tarjeta');
    await expect(medios).toContainText('Yape');

    // Y aquí está lo que solo se puede comprobar en un navegador de verdad:
    // Chromium de escritorio NO tiene `ApplePaySession`, así que Apple Pay no
    // se anuncia. Es el caso que ocurriría siempre en Android, y el motivo de
    // que este filtro exista.
    await expect(medios).not.toContainText('Apple Pay');
    // Google Pay sí: Chromium trae `PaymentRequest`.
    await expect(medios).toContainText('Google Pay');

    // Contra entrega sigue siendo lo marcado por defecto. Cambiar el medio por
    // el que menos usa la gente en Perú sería una decisión de producto tomada
    // de refilón por el orden de dos radios.
    await expect(page.locator('input[value="on_delivery"]')).toBeChecked();
  });

  test('PAGAR AHORA lleva a la pasarela, no a la página de gracias', async ({
    page,
  }) => {
    await agregarAlCarrito(page);
    await page.goto('/checkout');

    await page.getByLabel('Dirección').fill('Av. Larco 456, Miraflores');
    await page.getByRole('button', { name: /usar esta dirección/i }).click();
    await page.getByLabel('Nombre').fill('Rosa Quispe');
    await page.getByLabel('Teléfono').fill('+51987650002');

    // La pasarela de la semilla es un simulador y su URL no resuelve. Se
    // intercepta para poder afirmar ADÓNDE se manda al comprador sin depender
    // de que exista un servidor de Culqi: lo que se prueba es nuestra
    // redirección, no la página de ellos.
    await page.route('**/sandbox.culqi.test/**', (ruta) =>
      ruta.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<h1>Checkout de la pasarela</h1>',
      }),
    );

    await page.locator('input[value="online"]').check();
    await page.getByRole('button', { name: /confirmar pedido/i }).click();

    await expect(page).toHaveURL(/sandbox\.culqi\.test\/checkout\//);
    // Y NO a /gracias: un pedido en línea que acaba en «¡gracias!» sin haber
    // pasado por la pasarela es un pedido que nadie ha pagado y que el negocio
    // va a preparar creyendo que sí.
    await expect(page).not.toHaveURL(/gracias/);
  });

  test('EL MANUAL DE LA API se puede LEER, no solo citar', async ({ page }) => {
    // ADR-0020 dio tres motivos por los que una tienda de tercero no podía usar
    // la API. Dos se arreglaron con código; el tercero era que no había
    // documentación. El panel remitía a `docs/38-api-de-pedidos.md`, un archivo
    // de nuestro repositorio: quien tenía que leerlo no podía abrirlo.
    await page.goto('/desarrolladores');
    await expect(
      page.getByRole('heading', { name: 'API de pedidos' }),
    ).toBeVisible();
    await expect(page.getByText(/No calcules precios/)).toBeVisible();

    // Y el manual completo se sirve de verdad. Lo que puede fallar aquí es el
    // DESPLIEGUE: la imagen de producción solo copia `public/`, así que un
    // manual que viviera en `docs/` daría 404 solo en producción.
    //
    // Se pide DESDE EL NAVEGADOR y no con `page.request`: ese usa el resolvedor
    // de Node, que no entiende `*.localhost` —solo el navegador lo resuelve por
    // especificación— y fallaría por DNS sin llegar a mirar el manual.
    const manual = await page.evaluate(async () => {
      const r = await fetch('/manual-api.md');
      return { estado: r.status, texto: await r.text() };
    });
    expect(manual.estado).toBe(200);
    expect(manual.texto).toContain('X-Sahana-Key');
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

  test('LA PÁGINA DE ESTADO dice cómo va, y admite su propio límite', async ({
    page,
  }) => {
    // docs/26: «la confianza se construye antes del primer incidente». Es
    // pública y sin sesión a propósito: quien la mira puede ser justo el que
    // no consigue entrar.
    await page.goto('/estado');
    await expect(
      page.getByRole('heading', { name: 'Estado del servicio' }),
    ).toBeVisible();

    // Con la API arriba, el titular lo dice con PALABRAS y no solo en color:
    // esto se lee con prisa y a veces desde un móvil al sol (docs/25 §6).
    await expect(
      page.getByRole('heading', { name: 'Todo funciona' }),
    ).toBeVisible();

    // Y el límite de la página, en voz alta y no en letra pequeña: si se cae
    // todo, se cae ella, y su silencio entonces no significa «todo bien».
    await expect(
      page.getByText(/misma infraestructura que el producto/),
    ).toBeVisible();

    // Sin incidentes no se inventa ninguno para rellenar.
    await expect(page.getByText(/No ha habido ninguno todavía/)).toBeVisible();
  });

  test('LOS ALÉRGENOS se ven ANTES de añadir el plato al carrito', async ({
    page,
  }) => {
    // El restaurante los declaraba en su carta desde F4 y no los veía NADIE:
    // ni el cliente en la tienda ni la cocina en la comanda. El dato estaba
    // guardado y el cliente con alergia pedía a ciegas.
    await page.goto('/');
    await page.getByRole('link', { name: /Pollo a la brasa entero/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Pollo a la brasa entero',
    );

    const aviso = page.locator('.ficha__alergenos');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('mostaza');
    await expect(aviso).toContainText('soya');
    // Con la palabra delante, no solo en rojo: quien no distingue el color
    // tiene que enterarse igual (docs/25 §6).
    await expect(aviso).toContainText('Alérgenos');

    // Y ARRIBA del botón de añadir: quien tiene una alergia decide ahí si
    // sigue, y un aviso debajo del botón llega tarde.
    const yAviso = (await aviso.boundingBox())!.y;
    const yBoton = (await page
      .getByRole('button', { name: /Añadir/ })
      .first()
      .boundingBox())!.y;
    expect(yAviso).toBeLessThan(yBoton);
  });

  test('un plato SIN alérgenos declarados no dice «no contiene»', async ({
    page,
  }) => {
    // El restaurante no ha hecho esa afirmación: lo único que sabemos es que
    // no declaró ninguno. Afirmar de más en una alergia es el peor error.
    await page.goto('/');
    await page.getByRole('link', { name: /Chicha morada/ }).click();
    await expect(page.locator('.ficha__alergenos')).toHaveCount(0);
    await expect(page.getByText(/no contiene/i)).toHaveCount(0);
  });
});
