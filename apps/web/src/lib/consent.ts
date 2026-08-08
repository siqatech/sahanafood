/**
 * El texto EXACTO del consentimiento de marketing (RN-T10, Ley 29733).
 *
 * Vive aquí, y no junto a las acciones de servidor, por dos razones. La
 * técnica: un archivo `'use server'` **solo puede exportar funciones async**, y
 * exportar esta constante desde allí revienta la página entera en tiempo de
 * ejecución —con un 500 y sin pista en la compilación—. La de fondo, que es la
 * que importa: este texto tiene que ser LITERALMENTE el mismo que se enseña en
 * la casilla y el que se guarda con el consentimiento. Un solo sitio lo
 * garantiza; dos copias se separan en la primera revisión legal y entonces lo
 * guardado deja de acreditar lo que la gente vio.
 */
export const TEXTO_CONSENTIMIENTO =
  'Acepto recibir promociones y novedades de esta marca por WhatsApp o correo. ' +
  'Puedo darme de baja cuando quiera.';
