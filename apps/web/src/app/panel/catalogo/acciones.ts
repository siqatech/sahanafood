'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';
import type { Deshacer } from '../aviso';

export interface EstadoCarta {
  error?: string;
  ok?: string;
  /** Con qué revertir, cuando se puede. Lo pinta `AvisoConDeshacer`. */
  deshacer?: Deshacer;
  /**
   * Lo que se acababa de escribir. React vacía los campos no controlados al
   * terminar una acción de servidor, y ese vaciado llega DESPUÉS del error.
   */
  valores?: Record<string, string>;
}

/**
 * ¿Esta llamada ES un deshacer?
 *
 * Lo que evita: que revertir ofrezca a su vez revertir. Serían dos avisos que
 * se deshacen mutuamente sin fin, y a la tercera vuelta nadie sabría en qué
 * precio quedó el plato.
 */
function esDeshacer(form: FormData): boolean {
  return form.get('esDeshacer') !== null;
}

/**
 * Acciones de la carta.
 *
 * Todas de servidor, como en la tienda: el precio lo pone el servidor y el
 * navegador ni siquiera tiene la oportunidad de proponer uno. Aquí importa
 * todavía más — quien edita la carta está cambiando lo que se cobra.
 */

function traducir(error: unknown): EstadoCarta {
  if (error instanceof SesionCaducada) {
    // Una acción no puede redirigir a refrescar sin perder lo que el operador
    // acababa de escribir. Se lo decimos y recarga: el dato sigue en el campo.
    return {
      error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.',
    };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No hemos podido guardar el cambio. Inténtalo de nuevo.' };
}

/**
 * Soles escritos a mano → unidades menores, con aritmética entera.
 *
 * El mismo criterio que el archivo de alta: pasar por `Number` metería coma
 * flotante en la única cifra que no la admite.
 */
function aUnidadesMenores(valor: string): number | null {
  const m = /^(\d+)(?:[.,](\d{1,4}))?$/.exec(valor.trim());
  if (!m) return null;
  return Number(`${m[1]}${(m[2] ?? '').padEnd(4, '0')}`);
}

export async function ponerPrecio(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const productId = String(form.get('productId') ?? '');
  const canal = String(form.get('channel') ?? '').trim();
  const bruto = String(form.get('price') ?? '');

  const priceMinor = aUnidadesMenores(bruto);
  if (priceMinor === null) {
    return { error: `"${bruto}" no es un precio. Escríbelo como 12.50.` };
  }

  try {
    await panel.ponerPrecio({
      productId,
      // Vacío = precio base, que en la API es `channel` nulo.
      channel: canal === '' || canal === 'base' ? null : canal,
      priceMinor,
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');

  // Deshacer = volver a poner el precio que había. El valor anterior lo manda
  // el formulario, que ya lo tenía en pantalla: preguntárselo otra vez a la API
  // sería una llamada de más para un dato que el navegador acaba de enseñar.
  //
  // Solo si HABÍA precio antes. Un plato que estrena precio no se puede
  // «deshacer»: la API no borra precios, y un botón que no revierte de verdad
  // es peor que no ofrecerlo.
  const anterior = String(form.get('anterior') ?? '').trim();
  if (esDeshacer(form) || anterior === '') return { ok: 'Precio guardado.' };

  return {
    ok: 'Precio guardado.',
    deshacer: {
      rotulo: `Volver a S/ ${anterior}`,
      campos: { productId, channel: canal, price: anterior },
    },
  };
}

export async function pausar(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const productId = String(form.get('productId') ?? '');
  const canal = String(form.get('channel') ?? '*');
  const motivo = String(form.get('reason') ?? '').trim();
  // El motivo es obligatorio y no es burocracia: «sin pollo» y «se rompió la
  // freidora» se resuelven de forma distinta, y a las tres horas nadie se
  // acuerda de por qué está pausado.
  if (motivo.length < 3) {
    return {
      error: 'Escribe por qué lo pausas: en tres horas nadie se acuerda.',
    };
  }
  try {
    await panel.pausar(productId, [canal], motivo);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  // Deshacer una pausa es reactivar, y eso ya tiene su propia acción. Ocho
  // segundos importan aquí: pausar el plato equivocado en hora punta lo saca de
  // la carta de todos los canales a la vez.
  return {
    ok: 'Producto pausado.',
    ...(esDeshacer(form)
      ? {}
      : {
          deshacer: {
            rotulo: 'Volver a ponerlo a la venta',
            campos: { productId, channel: canal },
          },
        }),
  };
}

export async function reanudar(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const productId = String(form.get('productId') ?? '');
  const canal = String(form.get('channel') ?? '*');
  try {
    await panel.reanudar(productId, [canal]);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  // Sin deshacer: volver a pausar exige un motivo escrito, y un botón de
  // «deshacer» que abre otro formulario no es deshacer.
  return { ok: 'Producto reactivado.' };
}

/**
 * La foto de un plato.
 *
 * Se guarda una **dirección**, no un archivo: subir imágenes pide almacenamiento
 * de objetos, recorte y límites de tamaño, y nada de eso está decidido todavía
 * (queda como pregunta abierta en docs/22). Mientras tanto, pegar la URL de la
 * foto que el dueño ya tiene en su Instagram o en su Drive resuelve el 90 % del
 * problema —la carta con fotos vende más— sin comprometer una arquitectura de
 * archivos a medias.
 */
export async function ponerFoto(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const productId = String(form.get('productId') ?? '');
  const url = String(form.get('imageUrl') ?? '').trim();
  const quitar = form.get('quitar') !== null;

  try {
    await panel.ponerFoto(productId, quitar || url === '' ? null : url);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');

  const ok = quitar || url === '' ? 'Foto quitada.' : 'Foto guardada.';
  if (esDeshacer(form)) return { ok };

  // Deshacer devuelve la dirección anterior — o la quita, si antes no había.
  // Aquí es donde más falta hace: se llega pegando una URL, y una URL pegada
  // mal se ve al instante en la miniatura.
  const anterior = String(form.get('anterior') ?? '');
  return {
    ok,
    deshacer: {
      rotulo:
        anterior === '' ? 'Dejarlo sin foto' : 'Volver a la foto anterior',
      campos: { productId, imageUrl: anterior },
    },
  };
}

export async function crearProducto(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const brandId = String(form.get('brandId') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const sku = String(form.get('sku') ?? '').trim();
  const precio = String(form.get('price') ?? '').trim();
  const esCombo = form.get('isCombo') === 'on';
  if (name.length < 2) return { error: 'El producto necesita un nombre.' };

  const priceMinor = precio === '' ? null : aUnidadesMenores(precio);
  if (precio !== '' && priceMinor === null) {
    return { error: `"${precio}" no es un precio. Escríbelo como 12.50.` };
  }

  try {
    const creado = await panel.crearProducto({
      brandId,
      name,
      ...(sku ? { sku } : {}),
      ...(esCombo ? { isCombo: true } : {}),
    });
    // El precio base va en la misma acción: un producto sin precio no se ve en
    // ningún canal, así que crearlo y dejarlo invisible sería crear trabajo
    // pendiente sin decirlo.
    if (priceMinor !== null) {
      await panel.ponerPrecio({ productId: creado.id, priceMinor });
    }
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  if (esCombo) {
    // Un combo sin composición no descuenta insumos. Decirlo AL CREARLO evita
    // que se descubra un mes después, cuadrando un inventario que no cuadra.
    return {
      ok: `"${name}" creado como combo. Dile de qué se compone o no descontará insumos.`,
    };
  }
  return {
    ok:
      priceMinor === null
        ? `"${name}" creado. Ponle precio para que se vea en la tienda.`
        : `"${name}" creado y con precio.`,
  };
}

/**
 * Un grupo de modificadores: la pregunta que se le hace al cliente.
 *
 * `min`/`max` no son un detalle: con mínimo 1 la pregunta es obligatoria y el
 * pedido no se puede cerrar sin responderla —«¿término de la carne?»—, y con
 * mínimo 0 es un extra opcional. Quien monta la carta tiene que poder elegir
 * las dos, y la regla la valida `@sahana/domain`, el mismo código que corre en
 * el POS sin conexión.
 */
export async function crearGrupoDeModificadores(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const brandId = String(form.get('brandId') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const min = Number(form.get('minSelections') ?? 0);
  const max = Number(form.get('maxSelections') ?? 1);

  if (name.length < 2) {
    return {
      error: 'La pregunta necesita un nombre. Por ejemplo: «Guarnición».',
    };
  }
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1) {
    return { error: 'El mínimo y el máximo tienen que ser números enteros.' };
  }
  if (max < min) {
    return {
      error: `No se pueden elegir como mucho ${max} y como poco ${min}.`,
    };
  }

  try {
    await panel.crearGrupoDeModificadores({
      brandId,
      name,
      minSelections: min,
      maxSelections: max,
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  return {
    ok:
      min === 0
        ? `«${name}» creada. Es opcional: el cliente puede no elegir nada.`
        : `«${name}» creada. Hay que responderla para poder pedir.`,
  };
}

/**
 * Una opción del grupo, con su diferencia de precio.
 *
 * El delta puede ser NEGATIVO —«sin guarnición» descuenta— y por eso se acepta
 * el signo. Vacío es cero: la mayoría de las opciones no cambian el precio, y
 * obligar a escribir «0.00» en cada una es fricción por nada.
 */
export async function crearOpcionDeModificador(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const groupId = String(form.get('groupId') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const bruto = String(form.get('priceDelta') ?? '').trim();
  if (name.length < 1) return { error: 'La opción necesita un nombre.' };

  let priceDeltaMinor = 0;
  if (bruto !== '') {
    const negativo = bruto.startsWith('-');
    const magnitud = aUnidadesMenores(negativo ? bruto.slice(1) : bruto);
    if (magnitud === null) {
      return {
        error: `"${bruto}" no es un importe. Escríbelo 3.00, o -2.00 si descuenta.`,
        valores: { name, priceDelta: bruto },
      };
    }
    priceDeltaMinor = negativo ? -magnitud : magnitud;
  }

  try {
    await panel.crearOpcionDeModificador({ groupId, name, priceDeltaMinor });
  } catch (error) {
    return { ...traducir(error), valores: { name, priceDelta: bruto } };
  }
  revalidatePath('/panel/catalogo');
  return { ok: `«${name}» añadida.` };
}

/** Une o desune el grupo del plato. Es lo que hace que la pregunta se haga. */
export async function cambiarGrupoDelProducto(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const productId = String(form.get('productId') ?? '');
  const groupId = String(form.get('groupId') ?? '');
  const unir = form.get('unir') === '1';
  try {
    if (unir) {
      await panel.unirGrupoAProducto(productId, groupId);
    } else {
      await panel.desunirGrupoDeProducto(productId, groupId);
    }
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  return { ok: unir ? 'Añadida al plato.' : 'Quitada del plato.' };
}

/**
 * Añade o quita un componente del combo (RN-CAT-04).
 *
 * La API **reemplaza la lista entera**, así que la lista actual viaja en el
 * formulario y se manda completa. Es lo mismo que el horario del local y por lo
 * mismo: releerla dentro de la acción dejaría hueco para el cambio de otra
 * persona entre la lectura y la escritura.
 *
 * Y no es papeleo: el consumo de inventario de un combo va POR COMPONENTES. Un
 * combo con la lista vacía se vende y **no descuenta nada**, así que el stock
 * no baja y la pantalla de inventario miente en cada venta.
 */
export async function cambiarComposicion(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const comboId = String(form.get('comboId') ?? '');
  const quitar = String(form.get('quitar') ?? '').trim();
  const anadir = String(form.get('anadir') ?? '').trim();
  const bruto = String(form.get('cantidad') ?? '1').trim();

  const actuales = leerComponentes(form.get('actuales'));

  let siguientes: Array<{ productId: string; quantity: number }>;
  if (quitar !== '') {
    siguientes = actuales.filter((c) => c.productId !== quitar);
  } else {
    if (anadir === '') return { error: 'Elige qué plato lleva el combo.' };
    const cantidad = Number(bruto);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 99) {
      return {
        error: `"${bruto}" no es una cantidad. Escribe un número entero del 1 al 99.`,
        valores: { cantidad: bruto },
      };
    }
    // Repetir un componente no suma dos filas: se reemplaza la cantidad. Dos
    // filas del mismo plato descontarían bien pero se leerían mal, y la lista
    // es lo que alguien revisa cuando el stock no cuadra.
    siguientes = [
      ...actuales.filter((c) => c.productId !== anadir),
      { productId: anadir, quantity: cantidad },
    ];
  }

  try {
    await panel.ponerComposicion(comboId, siguientes);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  return {
    ok:
      siguientes.length === 0
        ? 'Combo vacío. Así se vende, pero no descuenta ningún insumo.'
        : quitar !== ''
          ? 'Quitado del combo.'
          : 'Añadido al combo.',
  };
}

/**
 * La composición actual viaja serializada en el formulario.
 *
 * Si el JSON viniera roto se prefiere no escribir a escribir una lista vacía:
 * vaciar un combo sin querer deja de descontar insumos y no lo nota nadie.
 */
function leerComponentes(
  bruto: FormDataEntryValue | null,
): Array<{ productId: string; quantity: number }> {
  if (typeof bruto !== 'string' || bruto === '') return [];
  try {
    const v: unknown = JSON.parse(bruto);
    return Array.isArray(v)
      ? (v as Array<{ productId: string; quantity: number }>)
      : [];
  } catch {
    return [];
  }
}
