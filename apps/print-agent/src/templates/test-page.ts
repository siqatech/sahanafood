import { EscPosBuilder } from '../escpos/builder.js';

/**
 * Página de prueba de impresora.
 *
 * Es el entregable real del instalador: «el servicio arrancó» no prueba nada
 * —el agente arranca igual con la impresora apagada—. Lo que cierra la
 * instalación es un papel en la mano.
 *
 * Por eso la página no dice «OK»: ejercita a propósito todo lo que se rompe en
 * una térmica recién conectada y lo deja visible en el papel.
 *
 * · **Acentos y ñ.** Si salen «Raci?n» o «RaciÃ³n», la tabla de caracteres está
 *   mal y TODAS las comandas saldrán así. Es el fallo más común y el que más
 *   tarde se descubre, porque el instalador rara vez imprime algo en español.
 * · **Ancho real.** La regla numerada delata en el acto si el papel es de
 *   58 mm y se configuró de 80 (o al revés): la línea se parte o sobra.
 * · **Tamaños y negrita.** Lo que distingue una comanda legible a un metro de
 *   un bloque de texto uniforme.
 * · **Corte.** Si el ticket sale cortado por la mitad, faltan avances antes de
 *   la cuchilla.
 */

export interface TestPageData {
  /** Nombre lógico con el que se configuró, para saber cuál de las dos es. */
  printerName: string;
  /** Cómo está conectada, tal cual salió de la configuración. */
  target: string;
  agentVersion: string;
  printedAt: string;
}

export interface TestPageOptions {
  width?: number | undefined;
}

/** Regla que hace evidente el ancho real del papel. */
function regla(width: number): string {
  let salida = '';
  for (let i = 1; salida.length < width; i++) {
    const marca = i % 10 === 0 ? String(i / 10) : '.';
    salida += marca;
  }
  return salida.slice(0, width);
}

export function buildTestPage(
  data: TestPageData,
  options: TestPageOptions = {},
): Buffer {
  const ancho = options.width ?? 48;
  const t = new EscPosBuilder({ width: ancho });

  t.init().align('center');
  t.size(1, 2).bold(true).line('SAHANA FOOD').bold(false).size(1, 1);
  t.line('Pagina de prueba de impresora');
  t.align('left').separator('=');

  t.columns('Impresora', data.printerName);
  // La conexión puede ser una ruta larga: se parte a propósito en vez de
  // dejar que la impresora la corte por donde le toque. En ESTA página
  // cualquier línea que se pase arruina la prueba — no se podría distinguir
  // «se partió porque el ancho está mal» de «se partió porque el texto es
  // largo», que es justo lo que la página existe para decidir.
  t.line('Conexion');
  t.wrapped(data.target);
  t.columns('Agente', data.agentVersion);
  t.columns('Fecha', data.printedAt);

  t.separator('-');

  // El texto que delata una tabla de caracteres mal configurada. Si esta línea
  // no se lee, ninguna comanda en español se leerá tampoco.
  t.bold(true).line('ACENTOS').bold(false);
  // Envueltas y no fijas: en papel de 58 mm (32 columnas) estas mismas frases
  // se desbordan, y una página de prueba que se desborda sola no puede
  // detectar un desbordamiento.
  t.wrapped('Ración de pollo a la brasa · ñandú · 25 °C');
  t.wrapped('¿Añadir guarnición? ¡Sí! Jalapeño, piña, maíz');
  t.wrapped('ÁÉÍÓÚ áéíóú ÑñÜü ¿¡ S/ 38,50');

  t.separator('-');
  t.bold(true).line(`ANCHO REAL (${ancho} caracteres)`).bold(false);
  t.line(regla(ancho));
  t.wrapped(
    'Si la regla no acaba justo en el borde, el ancho configurado no es el del papel.',
  );

  t.separator('-');
  t.bold(true).line('TAMANOS').bold(false);
  t.line('Normal: 2 x Hamburguesa clásica');
  t.size(1, 2).line('Doble alto: 2 x Hamburguesa').size(1, 1);
  t.size(2, 2).line('Doble: #1042').size(1, 1);
  t.bold(true).line('Negrita: sin cebolla').bold(false);

  t.separator('=').align('center');
  t.bold(true).line('*** PRUEBA CORRECTA ***').bold(false);
  t.wrapped(
    'Si lees esto completo y sin simbolos raros, la impresora esta lista.',
  );
  t.cut();

  return t.build();
}
