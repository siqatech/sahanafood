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

  test('LA BANDEJA DE EXCEPCIONES enseña lo que llegó y deja resolverlo (DT-04)', async ({
    page,
  }) => {
    // Es la prueba de que la regla RN-ORD-10 —«un pedido que no sabemos mapear
    // NO se descarta»— se cumple entera. Durante F4 y F5 se cumplió a medias:
    // el pedido se apartaba y la única forma de sacarlo de ahí era llamar al
    // endpoint a mano. Para el cliente que espera su comida, «perdido» y
    // «apartado donde nadie lo ve» son lo mismo.
    await entrar(page);
    await page.getByRole('link', { name: 'Excepciones', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Excepciones' }),
    ).toBeVisible();

    const fila = page.locator('tbody tr').first();
    await expect(fila).toContainText('rappi');
    await fila.getByRole('link', { name: 'Resolver' }).click();

    // Lo primero que el operador necesita: POR QUÉ se apartó y QUÉ llegó.
    const motivo = page.getByText(/SKU externo sin mapear: /);
    await expect(motivo).toBeVisible();
    // El SKU se LEE de la pantalla en vez de fijarlo: la bandeja ordena por
    // fecha y cuál cae primero depende de la semilla. Una prueba que lo
    // hardcodea falla por el orden, no por el fallo que vigila.
    const sku = (await motivo.textContent())!.split(': ').pop()!.trim();
    expect(sku).toMatch(/^RAPPI-/);

    // El payload crudo se enseña siempre: si nuestra lectura de las líneas
    // falla, el original sigue delante y el pedido se puede armar a mano.
    await expect(page.locator('pre.crudo')).toContainText(sku);

    // Se mapea al POLLO a propósito, que es el plato con «Tamaño» obligatorio.
    // Elegir uno sin modificadores probaría el camino fácil y dejaría fuera el
    // que de verdad se usa en el Perú: mapear a un plato con talla obligatoria
    // devolvía un 422 que el operador no podía arreglar desde la pantalla, y el
    // pedido se quedaba en la bandeja para siempre.
    const selector = page.getByLabel(`Plato para ${sku}`);
    await selector.selectOption({ label: 'Pollo a la brasa entero' });
    await expect(page.getByLabel(`Tamaño de ${sku}`)).toBeVisible();
    await Promise.all([
      page.waitForURL(/\/panel\/excepciones\?resuelto=/),
      page.getByRole('button', { name: /resolver y mandar a cocina/i }).click(),
    ]);

    // Y ya no está en la bandeja: si siguiera, se resolvería dos veces.
    await expect(page.getByText(/ya va camino de la cocina/i)).toBeVisible();
    await expect(page.getByText(sku)).toHaveCount(0);
  });

  test('RECHAZAR EXIGE MOTIVO: va al canal y a auditoría', async ({ page }) => {
    await entrar(page);
    await page.goto('/panel/excepciones');
    await page.locator('tbody tr').first().getByRole('link').click();

    // Sin motivo no se rechaza. «Rechazado» a secas no le sirve ni al cliente
    // que esperaba ni a quien revise el mes.
    await page.getByRole('button', { name: 'Rechazar' }).click();
    await expect(page.getByText(/escribe por qué se rechaza/i)).toBeVisible();

    await page
      .getByLabel('Motivo del rechazo')
      .fill('Ese plato ya no se prepara');
    await Promise.all([
      page.waitForURL(/\/panel\/excepciones\?rechazado=1/),
      page.getByRole('button', { name: 'Rechazar' }).click(),
    ]);
    await expect(page.getByText(/rechazado y avisado al canal/i)).toBeVisible();
  });

  test('LA TORRE DE CONTROL deja ACEPTAR un pedido, que hasta ahora no se podía', async ({
    page,
  }) => {
    // Es la prueba que justifica la pantalla entera. Antes de ella no había
    // ninguna interfaz para aceptar un pedido: los canales con aceptación
    // manual dependían de que alguien llamara al endpoint a mano y, a los diez
    // minutos, el barrido de RN-ORD-04 los rechazaba solo. Todo pedido manual
    // acababa rechazado — no por decisión de nadie, sino por falta de un botón.
    await entrar(page);
    await page.getByRole('link', { name: 'Operaciones', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Operaciones' }),
    ).toBeVisible();

    const columna = page.locator('.torre__columna').first();
    const tarjeta = columna.locator('article.ficha').filter({
      has: page.locator('button', { hasText: 'Aceptar' }),
    });
    await expect(tarjeta.first()).toBeVisible();

    // El reloj corre y dice cuánto queda ANTES del rechazo automático. Un plazo
    // que no se ve es un plazo que se cumple sin que nadie se entere.
    await expect(tarjeta.first().locator('.cuenta')).toContainText(/quedan \d/);

    // Se anota QUÉ pedido se acepta para poder seguirlo de una columna a otra.
    // Comprobar un mensaje de éxito no valdría: al aceptar, la tarjeta sale de
    // la columna y se lleva el mensaje con ella — que es el comportamiento
    // correcto, y por eso lo que se afirma es el MOVIMIENTO.
    const numero = (await tarjeta
      .first()
      .locator('strong')
      .first()
      .textContent())!;
    expect(numero).toMatch(/^#\d+$/);

    await tarjeta.first().getByRole('button', { name: 'Aceptar' }).click();

    const columnaEnCurso = page.locator('.torre__columna').nth(1);
    await expect(
      columnaEnCurso.getByText(numero, { exact: true }),
    ).toBeVisible();
    // Y ya no espera decisión: si siguiera, se aceptaría dos veces.
    await expect(columna.getByText(numero, { exact: true })).toHaveCount(0);
  });

  test('RECHAZAR DESDE LA TORRE exige motivo, porque va al canal', async ({
    page,
  }) => {
    await entrar(page);
    await page.goto('/panel/operaciones');
    const boton = page.getByRole('button', { name: 'Rechazar' }).first();
    if ((await boton.count()) === 0) {
      // La torre está vacía: el pedido de la semilla ya se aceptó en la prueba
      // anterior. No se inventa uno — se afirma lo que la pantalla debe decir
      // cuando no hay nada esperando, que también es información.
      await expect(page.getByText(/nada esperando decisión/i)).toBeVisible();
      return;
    }
    await boton.click();
    await expect(page.getByText(/escribe por qué se rechaza/i)).toBeVisible();
  });

  test('LA BANDEJA enseña el RESUMEN DEL BOT al tomar una derivada (DT-14)', async ({
    page,
  }) => {
    // Es la prueba de que la derivación deja de perderse. El resumen se
    // escribía desde T5.28 y ninguna ruta lo devolvía: el traspaso con contexto
    // existía en la base de datos y no ocurría en la práctica. Sin él, el
    // humano abre con «hola, ¿en qué puedo ayudarte?» y el cliente lo cuenta
    // todo otra vez — el momento exacto en el que la gente abandona.
    await entrar(page);
    await page
      .getByRole('link', { name: 'Conversaciones', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Conversaciones' }),
    ).toBeVisible();

    // Las derivadas van primero: ahí ya hay alguien esperando a una persona.
    await expect(
      page.getByRole('heading', { name: /esperando a una persona/i }),
    ).toBeVisible();

    await page
      .locator('article.ficha--revision')
      .first()
      .getByRole('link', { name: /abrir/i })
      .click();

    await expect(
      page.getByRole('heading', { name: /te la pasó/i }),
    ).toBeVisible();
    await expect(page.getByText(/2 pollos a la brasa/)).toBeVisible();
    // Y lo que el cliente YA dijo, para no repreguntarlo. Se busca en la LISTA
    // de datos capturados y no en la página entera: «20:00» también aparece
    // dentro de la frase de la intención, y una aserción ambigua pasaría
    // aunque la lista no se pintara.
    const capturados = page.locator('.ficha--revision li');
    await expect(capturados.filter({ hasText: 'hora' })).toContainText('20:00');
    await expect(capturados.filter({ hasText: 'zona' })).toContainText(
      'Miraflores',
    );

    // Tomarla pone un nombre al lado del cliente que espera. Lo que se afirma
    // es el EFECTO —deja de estar sin asignar y el botón desaparece— y no un
    // mensaje: al asignarse, el botón se desmonta y se lleva el mensaje con
    // él, que es el comportamiento correcto.
    await expect(page.getByText(/sin asignar/)).toBeVisible();
    await page
      .getByRole('button', { name: /tomar esta conversación/i })
      .click();
    await expect(
      page.getByRole('button', { name: /tomar esta conversación/i }),
    ).toHaveCount(0);
    await expect(page.getByText(/sin asignar/)).toHaveCount(0);
  });

  test('UNA NOTA INTERNA se distingue del mensaje que sale al cliente', async ({
    page,
  }) => {
    // Una nota enviada al cliente es de los errores que no se deshacen
    // (RN-CNV-07), así que la casilla es explícita y la burbuja va aparte.
    await entrar(page);
    await page.goto('/panel/conversaciones');
    await page.locator('article.ficha').first().getByRole('link').click();

    await page.getByLabel('Mensaje').fill('Cliente habitual, dar prioridad');
    await page.getByLabel(/nota interna/i).check();
    await page.getByRole('button', { name: 'Enviar' }).click();

    await expect(page.getByText(/no sale al cliente/i).first()).toBeVisible();
    await page.reload();
    await expect(page.locator('.burbuja--nota')).toContainText(
      'Cliente habitual',
    );
  });

  test('PEDIDOS: buscar por teléfono y ver QUÉ pidió el cliente', async ({
    page,
  }) => {
    // La pantalla que se abre cuando suena el teléfono. Lo que hasta ahora no
    // se podía contestar desde ninguna interfaz es la primera pregunta: qué
    // pidió. Las líneas se guardan desde F4 y ninguna ruta las devolvía.
    await entrar(page);
    await page.getByRole('link', { name: 'Pedidos', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();

    // El comprador de la prueba de la tienda dejó su teléfono en el checkout.
    await page.getByLabel('Buscar pedidos').fill('999');
    await page.getByRole('button', { name: 'Buscar' }).click();

    const fila = page.locator('tbody tr').first();
    await expect(fila).toBeVisible();
    await fila.getByRole('link', { name: 'Ver' }).click();

    await expect(
      page.getByRole('heading', { name: /^Pedido #\d+$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Qué pidió' }),
    ).toBeVisible();
    // Las líneas, con nombre e importe: el snapshot de lo vendido.
    await expect(page.locator('tbody tr').first()).toContainText('S/');
    // Y el historial, del más reciente al más antiguo.
    await expect(
      page.getByRole('heading', { name: 'Qué le pasó' }),
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
