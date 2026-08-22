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
    // Acotado al rótulo de la tarjeta: con datos de verdad las tablas por
    // marca y por canal también tienen una columna «Ventas», y la prueba
    // pasaba antes solo porque no había ventas que enseñar.
    await expect(
      page.locator('p.tarjeta__rotulo', { hasText: 'Ventas' }),
    ).toBeVisible();
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
      // Por NOMBRE, no por posición: `.nth(1)` daba por hecho que la columna
      // «Tienda web» sería siempre la segunda de la fila, y dejó de serlo en
      // cuanto la carta ganó una columna más.
      fila.getByRole('button', { name: 'Guardar el precio de web' }).click(),
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
      .locator('li.plato', { hasText: 'Pollo a la brasa entero' })
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
    await fila
      .getByRole('button', { name: 'Guardar el precio de web' })
      .click();
    await expect(page.getByText(/no es un precio/i)).toBeVisible();
  });

  test('LA FOTO de un plato se pone desde la carta y llega a la tienda', async ({
    page,
  }) => {
    // El campo existía en la base desde la migración 0008, la API sabía
    // leerlo y la tienda sabía pintarlo — pero el panel no tenía dónde
    // ponerlo. Una carta sin fotos vende bastante menos, y el dueño no tenía
    // ninguna forma de arreglarlo sin tocar SQL.
    await entrar(page);
    await page.goto('/panel/catalogo');
    const fila = page
      .locator('tbody tr')
      .filter({ hasText: 'Pollo a la brasa entero' })
      .first();

    await fila
      .getByLabel(/Dirección de la foto/)
      .fill('https://fotos.ejemplo.pe/pollo.jpg');
    await fila.getByRole('button', { name: 'Guardar foto' }).click();
    await expect(page.getByText('Foto guardada.')).toBeVisible();

    // La miniatura es el control: enseña lo que verá el cliente, que es la
    // única forma de notar que la dirección pegada apunta a otra cosa.
    await expect(fila.locator('img.foto-campo__miniatura')).toHaveAttribute(
      'src',
      'https://fotos.ejemplo.pe/pollo.jpg',
    );

    // Y se puede deshacer, que es lo que hace falta tras pegar una URL mala.
    await fila.getByRole('button', { name: 'Quitar foto' }).click();
    await expect(page.getByText('Foto quitada.')).toBeVisible();
    await expect(fila.locator('.foto-campo__hueco')).toBeVisible();
  });

  test('UNA FOTO POR HTTP se rechaza con un motivo, no rompe la tienda', async ({
    page,
  }) => {
    // Servida por http, el navegador marca la tienda entera como insegura o
    // bloquea la imagen. El dueño vería su tienda «rota» a una pantalla de
    // distancia de la causa, así que el «no» tiene que darse aquí.
    await entrar(page);
    await page.goto('/panel/catalogo');
    const fila = page.locator('tbody tr').first();
    // `type="url"` valida el formato en el navegador; lo que se prueba aquí es
    // la regla del servidor, que es la que de verdad manda.
    await fila
      .getByLabel(/Dirección de la foto/)
      .fill('http://fotos.ejemplo.pe/pollo.jpg');
    await fila.getByRole('button', { name: 'Guardar foto' }).click();
    await expect(page.getByText(/https/).first()).toBeVisible();
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
    // El NOMBRE del canal, no su identificador. La etiqueta ahora lleva el
    // color del canal y el rótulo que lee una persona; afirmar «rappi» en
    // minúscula era afirmar el dato crudo de la base, que nunca fue lo que
    // esta pantalla debía enseñar.
    await expect(fila).toContainText('Rappi');
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
    // `.first()` porque la prueba DEJA la nota puesta: en una segunda pasada
    // sobre la misma semilla hay dos y el modo estricto de Playwright falla —
    // un fallo que no dice nada del panel y que solo aparece la segunda vez.
    await expect(page.locator('.burbuja--nota').first()).toContainText(
      'Cliente habitual',
    );
  });

  test('LOS CHIPS filtran de verdad, y el CSV exporta LO FILTRADO', async ({
    page,
  }) => {
    // specs/ux/03 pide chips y export CSV en todo listado, y no había ninguno
    // de los dos. Lo que esta prueba vigila no es que los chips se pinten: es
    // que el filtro LLEGUE a la API. El cliente del panel tiraba `channel` al
    // suelo —igual que hacía con `search`— así que un filtro podía verse
    // marcado y devolver la lista entera, que es indistinguible de funcionar.
    await entrar(page);
    await page.goto('/panel/pedidos');

    const filas = page.locator('tbody tr');
    const total = await filas.count();
    expect(total, 'la semilla no dejó pedidos que filtrar').toBeGreaterThan(1);

    // La semilla mete pedidos de web, pos y rappi. Al filtrar por Rappi tienen
    // que quedar MENOS, y todos de Rappi.
    await page.getByRole('link', { name: 'Rappi', exact: true }).click();
    await expect(page).toHaveURL(/canal=rappi/);

    const soloRappi = page.locator('tbody tr');
    const cuantos = await soloRappi.count();
    expect(cuantos, 'el filtro por canal no redujo la lista').toBeLessThan(
      total,
    );
    expect(cuantos).toBeGreaterThan(0);
    // Y ninguna fila de otro canal se coló.
    await expect(soloRappi.filter({ hasText: 'Tienda web' })).toHaveCount(0);

    // El chip activo se dice también sin color (docs/25 §6).
    await expect(
      page.getByRole('link', { name: 'Rappi', exact: true }),
    ).toHaveAttribute('aria-current', 'true');

    // El export arrastra el filtro. Se pide desde el navegador porque lo que
    // importa es la respuesta con su cabecera, no el clic.
    const csv = await page.evaluate(async () => {
      const r = await fetch('/panel/pedidos/csv?canal=rappi');
      return {
        estado: r.status,
        tipo: r.headers.get('content-type'),
        adjunto: r.headers.get('content-disposition'),
        texto: await r.text(),
      };
    });
    expect(csv.estado).toBe(200);
    expect(csv.tipo).toContain('text/csv');
    // `attachment` es lo que hace que el navegador DESCARGUE en vez de pintar.
    expect(csv.adjunto).toContain('attachment');
    expect(csv.adjunto).toMatch(/pedidos-\d{4}-\d{2}-\d{2}\.csv/);

    // Separado por `;`, que es lo que abre Excel en español.
    expect(csv.texto).toContain('Numero;Canal;Estado');
    // Y solo Rappi: un export que ignora los filtros se parece demasiado al
    // bueno para que alguien lo note antes de mandarlo.
    const lineas = csv.texto.trim().split('\r\n').slice(1);
    expect(lineas.length).toBe(cuantos);
    expect(lineas.every((l) => l.includes('rappi'))).toBe(true);
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

    // Un teléfono de la semilla: es lo que la gente dice por teléfono, y es el
    // caso que la pantalla existe para resolver.
    await page.getByLabel('Buscar pedidos').fill('987666777');
    await page.getByRole('button', { name: 'Buscar' }).click();

    // Se comprueba que el buscador FILTRA, no solo que hay una fila. Esta
    // prueba pasaba con el buscador roto —la petición perdía el término por el
    // camino y devolvía la lista entera— porque siempre había una primera fila
    // que enseñar. En la pantalla que se abre cuando suena el teléfono, eso es
    // atender a un cliente mirando el pedido de otro.
    const fila = page.locator('tbody tr').first();
    await expect(fila).toBeVisible();
    await fila.getByRole('link', { name: 'Ver' }).click();
    await expect(page.getByText('Cliente que espera en casa')).toBeVisible();

    await expect(
      page.getByRole('heading', { name: /^Pedido #\d+$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Qué pidió' }),
    ).toBeVisible();
    // Las líneas, con nombre e importe: el snapshot de lo vendido.
    //
    // El importe con DOS decimales, no con los cuatro del `NUMERIC(14,4)`.
    // La línea los enseñaba crudos —«S/ 76.0000»— y el total de abajo, ya
    // formateado, ponía «S/ 76.00»: dos cifras distintas para lo mismo en la
    // misma pantalla, delante de quien está contestando un reclamo.
    await expect(page.locator('tbody tr').first()).toContainText(
      /S\/\s\d+\.\d{2}(?!\d)/,
    );
    // Y el historial, del más reciente al más antiguo.
    await expect(
      page.getByRole('heading', { name: 'Qué le pasó' }),
    ).toBeVisible();
  });

  test('CAJA separa lo que toca la gaveta de lo que no', async ({ page }) => {
    // La lectura que esta pantalla existe para evitar: un turno con mucha
    // tarjeta parece un faltante enorme si «esperado en efectivo» y «vendido»
    // se leen como el mismo número. El cajero acaba defendiéndose de una
    // acusación que era un error de lectura.
    await entrar(page);
    await page.getByRole('link', { name: 'Caja', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Caja y comprobantes' }),
    ).toBeVisible();

    await page
      .locator('tbody tr')
      .first()
      .getByRole('link', { name: 'Ver' })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Arqueo del turno' }),
    ).toBeVisible();

    // Fondo 50 + venta en efectivo 32 − salida 10 = 72. La venta con tarjeta
    // (45) NO entra: si entrara, el esperado sería 117 y la gaveta faltaría 45.
    await expect(page.getByText('S/ 72.00')).toBeVisible();

    // Y el desglose por medio de pago sí la enseña, que es lo que permite
    // explicar el turno completo. Se busca la CELDA y no el texto suelto: la
    // palabra «tarjeta» también aparece en el párrafo que explica la tabla.
    const fila = page.getByRole('row').filter({
      has: page.getByRole('cell', { name: 'Tarjeta', exact: true }),
    });
    await expect(fila).toContainText('S/ 45.00');
  });

  test('INVENTARIO explica POR QUÉ falta, no solo cuánto queda', async ({
    page,
  }) => {
    // El kardex es append-only por diseño (RN-INV-02) y eso solo sirve si
    // alguien puede leerlo. Se escribía desde F4 en tres sitios y ninguna ruta
    // lo devolvía: el libro era inalterable e ilegible.
    await entrar(page);
    await page.getByRole('link', { name: 'Inventario', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Inventario' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Existencias' }),
    ).toBeVisible();

    // Se salta al kardex de UN insumo, que es la pregunta real: «¿por qué
    // faltan 3 kg de carne?».
    const fila = page.locator('tbody tr').first();
    await fila.getByRole('link', { name: 'Ver movimientos' }).click();
    await expect(
      page.getByRole('heading', { name: /^Movimientos de / }),
    ).toBeVisible();

    // Y el libro dice que no se edita: es la propiedad que lo hace auditable.
    await expect(page.getByText(/append-only/i)).toBeVisible();
  });

  test('SE PUEDE DECLARAR un insumo desde el panel, sin SQL', async ({
    page,
  }) => {
    // El hueco que tenían catálogo y organización antes de DT-10: la mitad de
    // escritura. Sin ella un negocio nuevo no puede declarar sus insumos, y sin
    // receta el consumo automático no se dispara — el food cost se queda en
    // cero para todos menos para la pollería de las semillas.
    await entrar(page);
    await page.goto('/panel/inventario');

    const nombre = `Ají panca ${Date.now()}`;
    await page.getByLabel('Nombre', { exact: true }).fill(nombre);
    // `exact` en las dos: «Unidad» es subcadena de «Costo por unidad», y sin
    // ello el localizador resuelve a dos campos.
    await page.getByLabel('Unidad', { exact: true }).selectOption('g');
    await page.getByLabel('Costo por unidad', { exact: true }).fill('0.018');
    await page.getByRole('button', { name: 'Guardar insumo' }).click();

    await expect(page.getByText(/guardado/i).first()).toBeVisible();

    // Y aparece en el desplegable de la receta: es lo que demuestra que el
    // insumo quedó utilizable y no solo escrito.
    await page.reload();
    await expect(
      page.getByLabel('Consume').locator('option', { hasText: nombre }),
    ).toHaveCount(1);
  });

  test('EL EQUIPO se da de alta con SU cuenta y SU rol', async ({ page }) => {
    // Sin esta pantalla el dueño le da su contraseña al cajero: la cuenta que
    // aprueba descuadres, cambia precios y firma en auditoría. La trazabilidad
    // se vuelve ficción el primer día.
    await entrar(page);
    await page.getByRole('link', { name: 'Equipo', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Equipo' })).toBeVisible();

    // El propietario aparece y NO se le puede cambiar el rol ni desactivar.
    const filaDueno = page.locator('tbody tr').first();
    await expect(filaDueno).toContainText('Propietario');

    const correo = `cocinero-${Date.now()}@sahana.test`;
    await page.getByLabel('Nombre', { exact: true }).fill('Cocinero de prueba');
    await page.getByLabel('Correo', { exact: true }).fill(correo);
    await page.getByLabel('Rol', { exact: true }).selectOption('cook');
    await page
      .getByLabel('Contraseña', { exact: true })
      .fill('password-cocinero-1');
    await page.getByRole('button', { name: 'Dar de alta' }).click();

    await expect(page.getByText(/ya puede entrar/i)).toBeVisible();

    // Y queda en la lista con su rol y SIN PIN, que es lo que la pantalla
    // avisa: tiene cuenta pero todavía no puede abrir caja en el POS.
    await page.reload();
    const fila = page.locator('tbody tr').filter({ hasText: correo });
    await expect(fila).toContainText('sin PIN');
  });

  test('UNA CUENTA NUEVA no entra al POS hasta que tiene PIN y hay una tablet', async ({
    page,
  }) => {
    // Dar de alta no basta: al POS se entra con un aparato emparejado y un PIN.
    // Sin estas dos cosas la persona tiene cuenta, aparece en la lista, y no
    // puede abrir caja — que es una forma silenciosa de no estar dado de alta.
    await entrar(page);
    await page.goto('/panel/equipo');

    const correo = `cajera-${Date.now()}@sahana.test`;
    await page.getByLabel('Nombre', { exact: true }).fill('Cajera de prueba');
    await page.getByLabel('Correo', { exact: true }).fill(correo);
    await page.getByLabel('Rol', { exact: true }).selectOption('cashier');
    await page
      .getByLabel('Contraseña', { exact: true })
      .fill('password-cajera-1');
    await page.getByRole('button', { name: 'Dar de alta' }).click();
    await expect(page.getByText(/ya puede entrar/i)).toBeVisible();

    await page.reload();
    const fila = page.locator('tbody tr').filter({ hasText: correo });
    await expect(fila).toContainText('sin PIN');

    await fila.getByRole('textbox', { name: /^PIN de / }).fill('4821');
    await fila.getByRole('button', { name: 'Poner PIN' }).click();

    // Se comprueba el EFECTO, no el mensaje: `revalidatePath` remonta la fila.
    await expect(fila).not.toContainText('sin PIN');

    // Y el código de emparejamiento: se enseña una vez, en grande, con su hora
    // de caducidad. Es la credencial con la que la tablet entra.
    await page
      .getByRole('button', { name: 'Emitir código de emparejamiento' })
      .click();
    const codigo = page.locator('p.codigo');
    await expect(codigo).toContainText(/Código: [A-Z0-9-]+/);
    await expect(codigo).toContainText(/caduca a las \d{2}:\d{2}/);

    // No se guarda en ninguna pantalla: al recargar ya no está.
    await page.reload();
    await expect(page.locator('p.codigo')).toHaveCount(0);
  });

  test('LA COLA DE CORRECCIÓN se puede corregir, que era lo que faltaba', async ({
    page,
  }) => {
    // La pantalla de operaciones decía «hay que corregir y reenviar» y no
    // existía forma de corregir: reenviar manda el mismo RUC que el OSE acaba
    // de rechazar, y crear otro comprobante para la misma venta está prohibido.
    // La venta no se perdía; simplemente no se podía facturar nunca.
    await entrar(page);
    await page.getByRole('link', { name: 'Comprobantes' }).click();
    await expect(
      page.getByRole('heading', { name: 'Comprobantes' }),
    ).toBeVisible();

    const rechazado = page.locator('.ficha--revision').first();
    await expect(rechazado).toBeVisible();
    // El motivo del OSE se queda a la vista MIENTRAS se escribe el dato nuevo:
    // si desapareciera, se corregiría de memoria.
    await expect(rechazado).toContainText(/11 dígitos/);

    // Un RUC de nueve dígitos ni siquiera sale de aquí: gastar un intento
    // contra el OSE en algo que se ve mal desde la pantalla es tirar un envío.
    await rechazado.getByLabel('Número').fill('201234567');
    await rechazado
      .getByRole('button', { name: 'Corregir y reenviar' })
      .click();
    await expect(rechazado.getByText(/11 dígitos/).last()).toBeVisible();

    await rechazado.getByLabel('Número').fill('20123456789');
    await rechazado
      .getByRole('button', { name: 'Corregir y reenviar' })
      .click();

    // Se comprueba el EFECTO: el comprobante sale de la cola de rechazados.
    await expect(page.locator('.ficha--revision')).toHaveCount(0);
    await expect(
      page.getByText('Nada rechazado. La venta se declara sola al cobrar.'),
    ).toBeVisible();
  });

  test('DEVOLVER EL DINERO se puede hacer desde el pedido, con su motivo', async ({
    page,
  }) => {
    // `POST /payments/intents/:id/refund` existía desde T5.05 y no lo llamaba
    // nada en la interfaz: devolver dinero exigía un `curl`. Y el motivo, que
    // se guarda «para el panel y la auditoría», solo llegaba a la auditoría.
    await entrar(page);
    await page.getByRole('link', { name: 'Pedidos', exact: true }).click();
    // La lista no enseña el nombre del cliente —cabe el número, el canal y el
    // total—, así que se llega por la búsqueda, que sí mira el nombre.
    await page.getByLabel('Buscar pedidos').fill('Cliente que pagó online');
    await page.getByRole('button', { name: 'Buscar' }).click();
    await page
      .locator('tbody tr')
      .first()
      .getByRole('link', { name: 'Ver' })
      .click();

    await expect(page.getByRole('heading', { name: 'Cobros' })).toBeVisible();

    // Sin motivo no se devuelve: «se te devolvió» sin explicación es una
    // llamada de soporte garantizada.
    await page.getByRole('button', { name: /^Devolver S\// }).click();
    await expect(page.getByText(/al menos 5 caracteres/i)).toBeVisible();

    await page
      .getByLabel('Por qué se devuelve')
      .fill('Llegó frío y el cliente no lo quiso');
    await page.getByRole('button', { name: /^Devolver S\// }).click();

    // Se comprueba el EFECTO: el formulario deja sitio al estado de la
    // devolución, con el motivo que se escribió.
    await expect(
      page.getByText(/Llegó frío y el cliente no lo quiso/),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Devolver S\// }),
    ).toHaveCount(0);
  });

  test('EL HISTÓRICO dice QUIÉN, no un UUID, y se filtra por lo que se busca', async ({
    page,
  }) => {
    // Toda la trazabilidad que sostiene lo demás acaba aquí. `audit_log` se
    // escribía desde F3 en cuarenta sitios y la única ruta que lo devolvía
    // entregaba las filas crudas: «3f2a8c… cambió un precio» no contesta la
    // pregunta que trae a alguien a mirar la auditoría, que siempre es quién.
    await entrar(page);
    await page.getByRole('link', { name: 'Histórico' }).click();
    await expect(
      page.getByRole('heading', { name: 'Histórico' }),
    ).toBeVisible();

    // La entrada al panel que acaba de ocurrir, con nombre y apellido.
    const fila = page
      .locator('tbody tr')
      .filter({ hasText: 'Entró al sistema' })
      .first();
    await expect(fila).toBeVisible();
    await expect(fila).toContainText('Dueña de la tienda demo');

    // Y el filtro por acción, que es como se busca de verdad.
    await page.getByLabel('Filtrar por acción').selectOption('auth.login');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(page).toHaveURL(/accion=auth.login/);
    const filas = page.locator('tbody tr');
    await expect(filas.first()).toContainText('Entró al sistema');
    await expect(
      page.locator('tbody tr').filter({ hasText: 'Cambio de precio' }),
    ).toHaveCount(0);
  });

  test('LA MESA DE DESPACHO asigna, y dice POR QUÉ recomienda a cada uno', async ({
    page,
  }) => {
    // El módulo de reparto estaba entero desde T5.15 —zonas, ranking, estados,
    // saldos, liquidación— y sin una sola pantalla. En un SaaS para dark
    // kitchens con delivery, eso significa que el pedido se cocina, se empaca y
    // ahí se queda: nadie podía dar de alta a un repartidor ni asignar nada.
    await entrar(page);
    await page.getByRole('link', { name: 'Reparto' }).click();
    await expect(page.getByRole('heading', { name: 'Reparto' })).toBeVisible();

    // Los dos repartidores de la semilla, y uno ya en la calle.
    await expect(page.getByText('Luis Ramos').first()).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'En la calle' }),
    ).toBeVisible();

    // Un pedido listo sin envío: se le crea el envío y aparece por asignar.
    const listo = page
      .locator('.torre__columna')
      .filter({ hasText: 'Listos, sin envío' });
    const primero = listo.locator('article').first();
    await expect(primero).toBeVisible();
    await primero.getByRole('button', { name: 'Crear envío' }).click();

    const porAsignar = page
      .locator('.torre__columna')
      .filter({ hasText: 'Por asignar' });
    const envio = porAsignar.locator('article').first();
    await expect(envio).toBeVisible();

    // La recomendación viene CON MOTIVO: quien decide es una persona, y una
    // recomendación sin explicación no se sigue, se ignora.
    const opciones = envio.locator('select option');
    await expect(opciones.first()).toContainText(/—/);

    await envio.getByRole('button', { name: 'Asignar' }).click();

    // Se comprueba el EFECTO: deja de estar por asignar.
    await expect(
      page
        .locator('.torre__columna')
        .filter({ hasText: 'Por asignar' })
        .getByRole('button', { name: 'Asignar' }),
    ).toHaveCount(0);
  });

  test('EL ENLACE DE SEGUIMIENTO se emite en despacho y ABRE una página', async ({
    page,
  }) => {
    // `POST /delivery/shipments/:id/tracking-link` existía desde T5.16 y no lo
    // llamaba nadie: se emitía un token que ninguna pantalla componía y que
    // ninguna página sabía abrir. El enlace que se le mandaba al cliente era una
    // URL rota, y eso solo se descubre abriéndola — que es lo que hace esta
    // prueba y no puede hacer ninguna de la API.
    await entrar(page);
    await page.goto('/panel/reparto');

    const enCalle = page
      .locator('.torre__columna')
      .filter({ hasText: 'En la calle' });
    const envio = enCalle.locator('article.ficha').first();
    await envio
      .getByRole('button', { name: /enlace para el cliente/i })
      .click();

    const campo = envio.getByLabel('Enlace de seguimiento');
    await expect(campo).toBeVisible();
    const enlace = await campo.inputValue();
    expect(enlace).toContain('/seguimiento/');

    // Y ahora lo que importa: se abre y dice algo. Sin sesión, porque quien lo
    // recibe no tiene cuenta — el token público es toda la credencial.
    const contexto = await page.context().browser()!.newContext();
    const cliente = await contexto.newPage();
    try {
      await cliente.goto(enlace);
      await expect(cliente.getByLabel('Estado del pedido')).toBeVisible();
      await expect(cliente.getByText('En camino')).toBeVisible();

      // Y NO enseña lo que el enlace no debe llevar: se reenvía por WhatsApp y
      // acaba en capturas. Ni dirección, ni teléfono, ni importe.
      const texto = (await cliente.locator('body').innerText()).toLowerCase();
      expect(texto).not.toContain('av. larco');
      expect(texto).not.toContain('+51');
      expect(texto).not.toContain('s/');
    } finally {
      await contexto.close();
    }
  });

  test('UN CANAL SE CIERRA Y SE REABRE desde la torre, con su motivo', async ({
    page,
  }) => {
    // La saturación de cocina pausa canales sola desde T5.18, y eso ocurría
    // sin que nadie pudiera verlo ni deshacerlo: `pausedChannels` llevaba el
    // comentario «para el panel y el KDS» y no la exponía ninguna ruta. En el
    // local se vive como que las ventas se paran de golpe sin explicación.
    await entrar(page);
    await page.goto('/panel/operaciones');
    await expect(page.getByRole('heading', { name: 'Canales' })).toBeVisible();

    const rappi = page.locator('.canales article').filter({ hasText: 'rappi' });
    await expect(rappi).toContainText('abierto');

    // Sin motivo no se cierra: el turno siguiente no puede adivinar si reabre.
    await rappi.getByRole('button', { name: 'Cerrar rappi' }).click();
    await expect(rappi.getByText(/Di por qué se cierra/)).toBeVisible();

    await rappi.getByLabel('Motivo para cerrar rappi').fill('Sin pollo');
    await rappi.getByRole('button', { name: 'Cerrar rappi' }).click();

    // Se comprueba el EFECTO: queda cerrado, con el motivo y diciendo que lo
    // cerró una persona —lo que significa que no se reabre solo—.
    const cerrado = page
      .locator('.canales article')
      .filter({ hasText: 'rappi' });
    await expect(cerrado).toContainText('cerrado');
    await expect(cerrado).toContainText('Sin pollo');
    await expect(cerrado).toContainText(/solo se reabre a mano/i);

    await cerrado.getByRole('button', { name: 'Reabrir rappi' }).click();
    await expect(
      page.locator('.canales article').filter({ hasText: 'rappi' }),
    ).toContainText('abierto');
  });

  test('EL SEMÁFORO de un pedido dice el nivel sin depender del color', async ({
    page,
  }) => {
    // docs/25 pide el semáforo en cada tarjeta, y que la información NO viaje
    // solo en el color: en un mostrador con luz directa el ámbar y el rojo se
    // confunden. Aquí se comprueba lo segundo, que es lo que un cambio de CSS
    // puede romper sin que nadie lo note.
    await entrar(page);
    await page.goto('/panel/operaciones');

    const reloj = page.locator('.cuenta').first();
    await expect(reloj).toBeVisible();

    // El texto dice el estado por sí solo.
    await expect(reloj).toHaveText(/quedan \d{2}:\d{2}|plazo vencido/);

    // Y la clase es una de las tres del semáforo compartido. Si alguien renombra
    // los niveles en `@sahana/domain` y se olvida del CSS, el reloj se queda sin
    // color y esto lo caza.
    const clase = (await reloj.getAttribute('class')) ?? '';
    expect(clase).toMatch(/cuenta--(verde|ambar|rojo)/);
  });

  test('LOS UMBRALES DE COCINA se tocan desde el panel, y en el orden correcto', async ({
    page,
  }) => {
    // Los umbrales deciden cuántas ventas se dejan de aceptar en hora punta y
    // solo se podían fijar por API: el dueño veía su negocio dejar de vender a
    // las ocho y media sin ningún sitio donde decir «aguanta hasta cuarenta».
    await entrar(page);
    await page.getByRole('link', { name: 'Cocina' }).click();
    // `exact`: la cocina del negocio se llama «Cocina Central» y su h2 casaría
    // con el mismo texto.
    await expect(
      page.getByRole('heading', { name: 'Cocina', exact: true }),
    ).toBeVisible();

    const max = page.getByLabel('Platos a la vez antes de alargar la promesa');
    const pausa = page.getByLabel('Platos a la vez antes de CERRAR canales');

    // Sin orden no se guarda: un umbral que cierra canales sin decir CUÁLES
    // deja que el sistema elija por su cuenta de qué canal deja de entrar
    // dinero.
    await page.getByLabel('Orden en que se cierran').fill('');
    await max.fill('40');
    await pausa.fill('60');
    await page.getByRole('button', { name: 'Guardar umbrales' }).click();
    await expect(page.getByText(/di en qué orden/i)).toBeVisible();

    // Al revés tampoco: cerrar canales antes de haber alargado la promesa
    // apaga ventas sin haber probado lo que no cuesta nada.
    await page.getByLabel('Orden en que se cierran').fill('rappi, web');
    await max.fill('40');
    await pausa.fill('20');
    await page.getByRole('button', { name: 'Guardar umbrales' }).click();
    await expect(page.getByText(/tiene que ser MAYOR/)).toBeVisible();

    await pausa.fill('60');
    // Se espera a que la acción VIAJE antes de recargar. Recargar mientras va
    // en camino la aborta, y esperar al mensaje tampoco vale: `revalidatePath`
    // remonta el formulario y se lo lleva por delante. La prueba fallaría por
    // carrera, no por el fallo que vigila.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.request().isNavigationRequest() === false,
      ),
      page.getByRole('button', { name: 'Guardar umbrales' }).click(),
    ]);

    // Se comprueba el EFECTO: el valor guardado es el que se escribió.
    await page.reload();
    await expect(
      page.getByLabel('Platos a la vez antes de alargar la promesa'),
    ).toHaveValue('40');
    await expect(
      page.getByLabel('Platos a la vez antes de CERRAR canales'),
    ).toHaveValue('60');
  });

  test('LA RENTABILIDAD por marca y canal, ordenada por margen', async ({
    page,
  }) => {
    // Es la pregunta que justifica una dark kitchen —cuatro marcas en la misma
    // cocina, cuál gana dinero por cuál canal— y el endpoint existía desde
    // T4.29 sin que nada lo pintara. Sin esta tabla, seguir o no en un
    // marketplace se decide mirando la facturación, que es el número que más
    // engaña: el canal que más factura suele ser el que más comisión cobra.
    await entrar(page);
    await page.getByRole('link', { name: 'Rentabilidad' }).click();
    await expect(
      page.getByRole('heading', { name: 'Rentabilidad' }),
    ).toBeVisible();

    // Las dos ventas entregadas de la semilla, por canales distintos.
    const filas = page.locator('tbody tr');
    await expect(filas.first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'rappi' })).toBeVisible();

    // Las columnas que hacen que la tabla signifique algo: sin comisión y food
    // cost esto sería un informe de ventas más.
    await expect(
      page.getByRole('columnheader', { name: 'Comisión' }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Food cost' }),
    ).toBeVisible();

    // Y el cuadre del día, que la spec llama bug crítico si no cuadra.
    await expect(
      page.getByRole('heading', { name: 'Cuadre del día' }),
    ).toBeVisible();
  });

  test('EL AGENTE se configura, se prueba SIN clientes y se publica aparte', async ({
    page,
  }) => {
    // El módulo con más superficie construida y cero pantalla: identidad,
    // reglas, versiones, fuentes, sandbox y presupuesto. Y el agente habla en
    // nombre del negocio, por escrito, a clientes reales: sin pantalla, lo que
    // diga es lo que quedó sembrado el día del alta.
    await entrar(page);
    await page.getByRole('link', { name: 'Agente' }).click();
    await expect(page.getByRole('heading', { name: 'Agente' })).toBeVisible();

    // Sin mensaje de derivación no se guarda: es lo que lee el cliente cuando
    // el bot se rinde, y vacío significa silencio.
    await page.getByLabel('Cómo se llama').fill('Sahi');
    await page.getByLabel('Qué dice al pasar a una persona').fill('');
    await page.getByRole('button', { name: 'Guardar borrador' }).click();
    await expect(page.getByText(/qué se le dice al cliente/i)).toBeVisible();

    // Y lo tecleado NO se pierde con el error.
    await expect(page.getByLabel('Cómo se llama')).toHaveValue('Sahi');

    await page
      .getByLabel('Qué dice al pasar a una persona')
      .fill('Te paso con alguien del local.');
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.request().isNavigationRequest() === false,
      ),
      page.getByRole('button', { name: 'Guardar borrador' }).click(),
    ]);

    // Guardar NO es publicar, y la pantalla lo dice: es la separación que evita
    // que lo que el negocio dice por escrito cambie porque alguien tocó un
    // campo y se fue a comer.
    await expect(page.getByText(/Guardar .*no es publicar/i)).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Cómo se llama')).toHaveValue('Sahi');
  });

  test('LOS CANALES: reactivar un conector y ver dónde vive la tienda', async ({
    page,
  }) => {
    // Dos cosas que solo se podían hacer por API: conectar un marketplace —con
    // el secreto de firma dentro de un `curl`— y saber en qué dominio vive la
    // tienda, que no lo devolvía ninguna ruta. Quien registraba un dominio y
    // cerraba la pestaña perdía el token de verificación.
    await entrar(page);
    await page.getByRole('link', { name: 'Canales' }).click();
    await expect(page.getByRole('heading', { name: 'Canales' })).toBeVisible();

    // El dominio de la semilla, sirviendo.
    const dominio = page.locator('tbody tr').filter({ hasText: 'demo.local' });
    await expect(dominio).toContainText('Sirviendo');

    // Y un dominio nuevo: se registra pendiente y con su token a la vista,
    // porque hasta que el DNS no se compruebe la tienda NO se sirve ahí.
    const host = `tienda-${Date.now()}.mipolleria.pe`;
    await page.getByLabel('Dominio', { exact: true }).fill(host);
    await page.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.getByText(/Añade este TXT/).first()).toBeVisible();

    await page.reload();
    const nuevo = page.locator('tbody tr').filter({ hasText: host });
    await expect(nuevo).toContainText('Sin verificar');
    await nuevo.getByRole('button', { name: 'Verificar' }).click();

    // Se comprueba el EFECTO: pasa a servir.
    await expect(
      page.locator('tbody tr').filter({ hasText: host }),
    ).toContainText('Sirviendo');
  });

  test('LA BAJA de un cliente se registra CON SU TEXTO y se puede comprobar', async ({
    page,
  }) => {
    // `wa_consents` guarda el texto exacto que aceptó la persona y
    // `opted_out` decide en cada envío. Las dos cosas funcionaban y ninguna
    // ruta las devolvía: la baja se respetaba y nadie podía comprobarla. El
    // día que alguien dice «pedí que no me escribieran», la respuesta era
    // mirar la base de datos a mano.
    await entrar(page);
    await page.getByRole('link', { name: 'Mensajería' }).click();
    await expect(
      page.getByRole('heading', { name: 'Mensajería' }),
    ).toBeVisible();

    const telefono = `+5198${String(Date.now()).slice(-7)}`;

    // Sin el texto exacto no se registra: un «sí» no demuestra qué aceptó.
    await page.getByLabel('Teléfono').fill(telefono);
    await page.getByLabel('De dónde salió').fill('mostrador');
    await page.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.getByText(/texto exacto que aceptó/i)).toBeVisible();

    await page.getByLabel('Qué se registra').selectOption('revoked');
    await page
      .getByLabel('Texto exacto')
      .fill('Dijo por teléfono que no quiere más mensajes.');
    // Se espera a que la acción llegue antes de navegar: irse mientras va en
    // camino la aborta, y el fallo parecería del registro y no de la prueba.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.request().isNavigationRequest() === false,
      ),
      page.getByRole('button', { name: 'Registrar' }).click(),
    ]);

    // Se comprueba el EFECTO: aparece de baja y su permiso se puede leer.
    await page.goto(`/panel/mensajeria?tel=${encodeURIComponent(telefono)}`);
    const fila = page.locator('tbody tr').filter({ hasText: telefono });
    await expect(fila).toContainText('De baja');
    await fila.getByRole('link', { name: 'Ver permiso' }).click();
    await expect(page.getByText(/no quiere más mensajes/)).toBeVisible();
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
