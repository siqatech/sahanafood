'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoExcepcion {
  error?: string;
  ok?: string;
}

function traducir(error: unknown): EstadoExcepcion {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No hemos podido guardar el cambio. Inténtalo de nuevo.' };
}

/**
 * Resuelve el mapeo de un pedido apartado (RN-ORD-10).
 *
 * El formulario manda una línea por cada una que trajo el canal: `producto-N`
 * con nuestro producto y `cantidad-N` con las unidades. Las que se dejan sin
 * elegir **se descartan a propósito** —un canal puede mandar un cargo por
 * servicio que aquí no es un plato— pero al menos una tiene que quedar, y de
 * eso ya se queja la API.
 */
export async function resolver(
  _prev: EstadoExcepcion,
  form: FormData,
): Promise<EstadoExcepcion> {
  const orderId = String(form.get('orderId') ?? '');
  const total = Number(form.get('total') ?? 0);

  const lines: Array<{
    productId: string;
    quantity: number;
    modifierOptionIds?: string[];
  }> = [];
  const recordables: Array<{ externalSku: string; productId: string }> = [];

  for (let i = 0; i < total; i++) {
    const productId = String(form.get(`producto-${i}`) ?? '').trim();
    if (productId === '') continue;
    const cantidad = Number(form.get(`cantidad-${i}`) ?? 1);
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      return { error: `La cantidad de la línea ${i + 1} no es válida.` };
    }
    // Los modificadores obligatorios llegan como un campo por grupo. Sin
    // ellos, mapear a un plato con «Tamaño» obligatorio devolvía un 422 que el
    // operador no podía arreglar desde la pantalla: el pedido se quedaba en la
    // bandeja para siempre y la pantalla parecía rota sin estarlo.
    const modificadores = form
      .getAll(`modificador-${i}`)
      .map((v) => String(v).trim())
      .filter((v) => v !== '');

    lines.push({
      productId,
      quantity: cantidad,
      ...(modificadores.length > 0 ? { modifierOptionIds: modificadores } : {}),
    });

    const sku = String(form.get(`sku-${i}`) ?? '').trim();
    if (sku !== '') recordables.push({ externalSku: sku, productId });
  }

  if (lines.length === 0) {
    return {
      error:
        'Elige al menos un plato nuestro: sin líneas no hay pedido que aceptar.',
    };
  }

  try {
    await panel.resolverMapeo(orderId, lines);
  } catch (error) {
    return traducir(error);
  }

  // El mapeo permanente va DESPUÉS y su fallo no deshace nada: el pedido ya
  // está resuelto y la comida tiene que salir. Que el próximo pedido vuelva a
  // apartarse es molesto; perder este, no.
  const recordar = form.get('recordar') === 'on';
  const connectionId = String(form.get('connectionId') ?? '').trim();
  let aviso = '';
  if (recordar && connectionId !== '') {
    try {
      for (const m of recordables) {
        await panel.mapearSku({ connectionId, ...m });
      }
    } catch {
      aviso =
        ' El pedido quedó resuelto, pero no se pudo guardar el mapeo para la próxima vez.';
    }
  }

  revalidatePath('/panel/excepciones');
  redirect(
    `/panel/excepciones?resuelto=${encodeURIComponent(orderId)}${aviso ? '&aviso=1' : ''}`,
  );
}

/**
 * Rechaza el pedido apartado.
 *
 * Existe porque no todo se resuelve: un pedido de una marca que ya no
 * trabajamos, o una dirección fuera de zona, no tiene mapeo posible. Sin esta
 * salida la bandeja solo crece, y una bandeja que solo crece se deja de mirar.
 */
export async function rechazar(
  _prev: EstadoExcepcion,
  form: FormData,
): Promise<EstadoExcepcion> {
  const orderId = String(form.get('orderId') ?? '');
  const motivo = String(form.get('reason') ?? '').trim();
  // El motivo viaja al canal y queda en auditoría: «rechazado» a secas no le
  // sirve ni al cliente que esperaba ni a quien revise el mes.
  if (motivo.length < 3) {
    return { error: 'Escribe por qué se rechaza: va al canal y a auditoría.' };
  }
  try {
    await panel.rechazarPedido(orderId, motivo);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/excepciones');
  redirect('/panel/excepciones?rechazado=1');
}
