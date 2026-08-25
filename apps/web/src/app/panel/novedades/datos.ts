/**
 * Novedades: qué cambió y qué puedes hacer ahora que antes no (specs/ux/03,
 * docs/26: «historial de cambios visible en el panel con lenguaje de operador,
 * no de developer»).
 *
 * ## Por qué un archivo del repositorio y no una tabla
 *
 * Esto no es un dato del negocio: es lo mismo para todos los clientes, y una
 * tabla obligaría a inventar una pantalla para escribirlo y un plano de control
 * donde guardarlo. Aquí viaja **con el código que describe**, así que se revisa
 * en el mismo cambio que lo produce y **no puede mentir**: si la línea está en
 * producción, la función está en producción.
 *
 * ## Cómo se escribe una entrada
 *
 * En la lengua del operador, no en la del que programa. La prueba es simple:
 * **si empieza por un verbo que hace el sistema, está mal**; tiene que empezar
 * por lo que ahora puede hacer una persona.
 *
 *   mal → «Se añadió el endpoint de importación de catálogo por CSV.»
 *   bien → «Ya puedes pegar tu carta desde Excel y ver qué cambia antes de
 *           aplicarla.»
 *
 * Y cada una lleva **dónde se usa**. Una novedad que no dice dónde está obliga
 * a buscarla por el menú, y a la tercera nadie las lee.
 */

export interface Novedad {
  /** AAAA-MM-DD. Sirve de identificador y de orden. */
  fecha: string;
  titulo: string;
  /** Qué se puede hacer ahora. Una o dos frases, sin jerga. */
  detalle: string;
  /** Dónde se usa. Ruta del panel; omitida si no vive en una pantalla. */
  donde?: string;
  dondeRotulo?: string;
}

/**
 * De la más reciente a la más antigua.
 *
 * Se ordena al leer y no se confía en el orden del archivo: una entrada nueva
 * pegada al final por descuido saldría la última, que es justo donde no se ve.
 */
export const NOVEDADES: Novedad[] = [
  {
    fecha: '2026-08-25',
    titulo: 'Tus clientes ya ven los alérgenos de cada plato',
    detalle:
      'Los que declaras en tu carta salen en la ficha del plato, antes del botón de añadir. Si no declaras ninguno, tu tienda no dice nada: no afirma que el plato no lleve nada.',
    donde: '/panel/catalogo',
    dondeRotulo: 'Se declaran en Carta',
  },
  {
    fecha: '2026-08-23',
    titulo: 'Comprueba si el problema es nuestro antes de escribirnos',
    detalle:
      'Hay una página pública que dice si somos nosotros los que estamos fallando. Cuando algo se cae, ahí lo contamos: qué dejó de funcionar y qué hicimos para que no vuelva a pasar.',
    donde: '/panel/ayuda',
    dondeRotulo: 'Enlazada desde Ayuda',
  },
  {
    fecha: '2026-08-23',
    titulo: 'Sabes con quién hablas antes de contestar',
    detalle:
      'El pedido te dice si es la primera vez que te compra o si es de los de siempre, con cuántos pedidos lleva. Ya no hay que salir a buscar el teléfono en otra pantalla.',
    donde: '/panel/pedidos',
    dondeRotulo: 'En cada pedido',
  },
  {
    fecha: '2026-08-23',
    titulo: 'Baja tu carta y tus clientes cuando quieras',
    detalle:
      'Tu carta se baja en el mismo formato con el que se pega: la corriges en Excel y la vuelves a subir. Tu lista de clientes también se baja, con lo que ha gastado cada uno. Son tuyos y no hay que pedírselo a nadie.',
    donde: '/panel/catalogo',
    dondeRotulo: 'En Carta y en Clientes',
  },
  {
    fecha: '2026-08-23',
    titulo: 'Pídenos ayuda sin tener que explicar quién eres',
    detalle:
      'Escribe qué te pasa y te abrimos WhatsApp con el mensaje listo. Antes de mandarlo ves exactamente qué se adjunta —tu negocio, tu local y tu versión del programa— y puedes quitarlo con una casilla. De tus clientes no se adjunta nada.',
    donde: '/panel/ayuda',
    dondeRotulo: 'En Configuración → Ayuda',
  },
  {
    fecha: '2026-08-23',
    titulo: 'Practica sin ensuciar tus ventas de verdad',
    detalle:
      'Mientras estés en modo práctica puedes cobrar, anular y cerrar caja con descuadre sin miedo. Cuando estés listo, un botón borra las pruebas y deja tu carta y tu configuración intactas.',
    donde: '/panel',
    dondeRotulo: 'En Hoy',
  },
  {
    fecha: '2026-08-22',
    titulo: 'Pega tu carta desde Excel',
    detalle:
      'Copia las filas de tu hoja y pégalas: verás qué platos son nuevos, cuáles cambian de precio y cuáles quedan igual ANTES de aplicar nada. Volver a pegarla corregida no duplica nada.',
    donde: '/panel/catalogo/importar',
    dondeRotulo: 'En Carta → Importar desde Excel',
  },
  {
    fecha: '2026-08-22',
    titulo: 'El cliente recibe solo el enlace para seguir su pedido',
    detalle:
      'Al salir el pedido, el aviso de WhatsApp lleva dentro el enlace de seguimiento. Antes había que emitirlo y pegarlo a mano en el chat.',
    donde: '/panel/reparto',
    dondeRotulo: 'En Reparto',
  },
  {
    fecha: '2026-08-22',
    titulo: 'Sabes qué falta para abrir el local',
    detalle:
      'La portada te dice, en orden, lo que queda por hacer antes de vender de verdad: cajero con PIN, caja de prueba, comprobante aceptado y una comanda que llegue a cocina. Desaparece sola al terminar.',
    donde: '/panel',
    dondeRotulo: 'En Hoy',
  },
  {
    fecha: '2026-08-22',
    titulo: 'Ponles foto a tus platos',
    detalle:
      'Pega la dirección de la foto en cada plato de la carta y se verá en tu tienda. La miniatura te enseña lo que verá el cliente, así que una dirección mal pegada se nota al instante.',
    donde: '/panel/catalogo',
    dondeRotulo: 'En Carta',
  },
  {
    fecha: '2026-08-22',
    titulo: 'Exporta lo que estés viendo, en cualquier listado',
    detalle:
      'Pedidos, histórico, comprobantes, existencias y rentabilidad se bajan en un archivo que abre Excel, con los filtros que tengas puestos. El de existencias trae una columna vacía para ir anotando el conteo a mano.',
    donde: '/panel/pedidos',
    dondeRotulo: 'En Pedidos',
  },
  {
    fecha: '2026-08-22',
    titulo: 'Deshacer, ocho segundos',
    detalle:
      'Al cambiar un precio, pausar un plato o poner una foto tienes ocho segundos para deshacerlo. Los dedos gordos en tablet existen.',
    donde: '/panel/catalogo',
    dondeRotulo: 'En Carta',
  },
  {
    fecha: '2026-08-22',
    titulo: 'De un vistazo, cuánto ganas y no solo cuánto vendes',
    detalle:
      'Rentabilidad ahora suma el periodo entero: venta neta, margen y ticket promedio, con una barra que dice cuánto pesa cada marca y canal. La comisión y el food cost ya venían descontados.',
    donde: '/panel/reportes',
    dondeRotulo: 'En Rentabilidad',
  },
  {
    fecha: '2026-08-22',
    titulo: 'En la cocina se ve de dónde vino cada pedido',
    detalle:
      'Las comandas del KDS llevan el canal con su color. Un pedido de Rappi tiene un repartidor esperando en la puerta y uno de la tienda web es programado: no se cocinan en el mismo orden.',
  },
];
