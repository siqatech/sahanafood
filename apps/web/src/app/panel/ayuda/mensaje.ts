/**
 * El mensaje que se manda a soporte (docs/26 «Soporte como producto»).
 *
 * Está aparte de la pantalla, y en funciones puras, por dos razones. La primera
 * es que aquí se decide **qué sale del sistema**, y eso merece pruebas propias
 * en vez de comprobarse mirando un WhatsApp. La segunda es que el texto es el
 * producto: quien lo recibe tiene que poder atender sin pedir tres datos más, y
 * quien lo manda tiene que poder leerlo entero antes de mandarlo.
 *
 * ## Lo que NUNCA se adjunta
 *
 * Ni un dato de los clientes del cliente: ni teléfono, ni dirección, ni nombre,
 * ni el contenido de un pedido. Un canal de soporte es una puerta hacia fuera
 * del sistema, y el día que alguien pida ayuda con «el pedido de la señora que
 * llamó» no debe irse con él la ficha de la señora. Lo que se adjunta describe
 * **el negocio y el programa**, no a quién le vende.
 */

/** Lo que la pantalla sabe del negocio y de la instalación. */
export interface ContextoDeSoporte {
  /** Razón social o nombre comercial. Es lo que soporte busca en su lista. */
  negocio: string;
  /** Local desde el que se pide ayuda; puede no haber ninguno todavía. */
  local: string | null;
  /** Identificador del cliente. Sirve para encontrarlo sin ambigüedad. */
  tenantId: string;
  /** Versión desplegada. Sin esto, soporte no sabe si el fallo ya está
   *  arreglado y pide que se repita media hora de pruebas. */
  version: string;
  /** Fecha y hora tal y como las ve el operador (hora de Lima). */
  cuando: string;
  /** Código de una incidencia concreta, si el operador lo copió. */
  codigoDeError?: string | undefined;
}

export interface EntradaDelMensaje {
  /** Lo que el operador escribe con sus palabras. */
  texto: string;
  contexto: ContextoDeSoporte;
  /** Si el operador dejó marcada la casilla de adjuntar los datos técnicos. */
  adjuntarDatos: boolean;
}

const SIN_DATO = '—';

/**
 * Compone el mensaje.
 *
 * El bloque técnico va AL FINAL y separado: arriba queda lo que la persona
 * quiso decir, que es lo que se lee primero. Al revés, soporte abre el chat y
 * ve una ficha de sistema donde esperaba una frase.
 */
export function construirMensaje({
  texto,
  contexto,
  adjuntarDatos,
}: EntradaDelMensaje): string {
  const cuerpo = texto.trim();
  const partes = ['Hola, necesito ayuda con Sahana Food.'];
  if (cuerpo) partes.push(cuerpo);

  if (adjuntarDatos) {
    const filas = [
      `Negocio: ${contexto.negocio || SIN_DATO}`,
      `Local: ${contexto.local ?? SIN_DATO}`,
      `Cliente: ${contexto.tenantId || SIN_DATO}`,
      `Versión: ${contexto.version || SIN_DATO}`,
      `Fecha: ${contexto.cuando || SIN_DATO}`,
    ];
    // Solo si existe: una línea «Código de error: —» en cada mensaje enseña a
    // ignorar el campo, y entonces tampoco se lee el día que sí trae uno.
    if (contexto.codigoDeError?.trim()) {
      filas.push(`Código de error: ${contexto.codigoDeError.trim()}`);
    }
    partes.push(`--- Datos técnicos ---\n${filas.join('\n')}`);
  }

  return partes.join('\n\n');
}

/**
 * Enlace de WhatsApp, o `null` si no hay número de soporte configurado.
 *
 * Devuelve `null` en vez de un enlace roto a propósito: un botón que abre
 * WhatsApp sin destinatario hace creer que el mensaje salió. Cuando no hay
 * número, la pantalla enseña el texto para copiarlo, que sigue sirviendo.
 */
export function enlaceDeWhatsApp(
  numero: string | undefined,
  mensaje: string,
): string | null {
  // `wa.me` quiere solo dígitos: ni «+», ni espacios, ni guiones. Se limpia
  // aquí y no al configurar porque el número lo escribe una persona en una
  // variable de entorno, y ahí caben las tres formas.
  const digitos = (numero ?? '').replace(/\D/g, '');
  if (digitos.length < 8) return null;
  return `https://wa.me/${digitos}?text=${encodeURIComponent(mensaje)}`;
}
