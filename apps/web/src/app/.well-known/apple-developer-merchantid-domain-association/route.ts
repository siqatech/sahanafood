import { shop, ApiError } from '../../../lib/api';

/**
 * Verificación de dominio de Apple Pay.
 *
 * La ruta es EXACTA y la fija Apple, no nosotros: comprueba
 * `/.well-known/apple-developer-merchantid-domain-association` en el dominio de
 * la tienda antes de dejar que aparezca su botón. Es una de las poquísimas
 * direcciones de todo el sistema cuyo camino no elegimos.
 *
 * Y en un SaaS multimarca no es *un* archivo: es uno **por dominio de cliente**,
 * servido por este mismo proceso, y cuál toca depende del `Host` de quien
 * pregunta — el mismo problema que resuelve el resto de la tienda.
 *
 * Si el dominio no lo tiene cargado, 404. Servir un archivo vacío le diría a
 * Apple que el dominio existe y está mal configurado, que es más difícil de
 * depurar que «no está»: el botón desaparece igual y sin ningún error visible.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const { content } = await shop.applePayVerification();
    return new Response(content, {
      headers: {
        'content-type': 'text/plain',
        // Apple relee este archivo al renovar el dominio; una caché larga
        // convertiría un cambio de certificado en un botón que desaparece
        // durante horas.
        'cache-control': 'public, max-age=300',
      },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return new Response('', { status: 404 });
    }
    throw error;
  }
}
