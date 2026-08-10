'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoEquipo {
  error?: string;
  ok?: string;
}

function traducir(error: unknown): EstadoEquipo {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No se pudo guardar. Inténtalo de nuevo.' };
}

/**
 * Da de alta a alguien del equipo.
 *
 * La contraseña la escribe quien da de alta y se la entrega a la persona. No
 * hay invitación por correo todavía y decirlo es mejor que fingirlo: un flujo
 * de invitación a medias —que manda el correo pero no caduca el enlace, o que
 * no lo manda y nadie se entera— es peor que entregar la contraseña a mano.
 */
export async function crearUsuario(
  _prev: EstadoEquipo,
  form: FormData,
): Promise<EstadoEquipo> {
  const email = String(form.get('email') ?? '').trim();
  const fullName = String(form.get('fullName') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const roleCode = String(form.get('roleCode') ?? '').trim();

  if (fullName.length < 2) return { error: 'La persona necesita un nombre.' };
  if (roleCode === '') {
    // Sin rol la cuenta entra y no puede hacer nada, y entonces alguien le
    // presta una con permisos «mientras tanto» — justo lo que esto evita.
    return { error: 'Elige un rol: una cuenta sin rol no sirve para nada.' };
  }
  if (password.length < 12) {
    return { error: 'La contraseña necesita al menos 12 caracteres.' };
  }

  try {
    await panel.crearUsuario({ email, fullName, password, roleCode });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/equipo');
  return {
    ok: `${fullName} ya puede entrar. Entrégale la contraseña en persona.`,
  };
}

export async function cambiarRol(
  _prev: EstadoEquipo,
  form: FormData,
): Promise<EstadoEquipo> {
  const userId = String(form.get('userId') ?? '');
  const roleCode = String(form.get('roleCode') ?? '');
  try {
    await panel.cambiarRol(userId, roleCode);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/equipo');
  return { ok: 'Rol actualizado.' };
}

export async function cambiarEstado(
  _prev: EstadoEquipo,
  form: FormData,
): Promise<EstadoEquipo> {
  const userId = String(form.get('userId') ?? '');
  const active = form.get('active') === 'true';
  try {
    await panel.cambiarEstadoUsuario(userId, active);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/equipo');
  return { ok: active ? 'Cuenta reactivada.' : 'Cuenta desactivada.' };
}

/**
 * Pone el PIN de un operador.
 *
 * El PIN es lo que le deja entrar al POS: sin él la persona tiene cuenta y no
 * puede abrir caja, que es una forma silenciosa de no estar dado de alta. Lo
 * fija un administrador y **la API marca que debe cambiarlo** en su primer uso
 * (RN-IDN-03) — un PIN que puso otra persona y que nunca se cambia es un PIN
 * que conocen dos.
 */
export async function ponerPin(
  _prev: EstadoEquipo,
  form: FormData,
): Promise<EstadoEquipo> {
  const userId = String(form.get('userId') ?? '');
  const pin = String(form.get('pin') ?? '').trim();
  if (!/^\d{4,6}$/.test(pin)) {
    return { error: 'El PIN son 4 a 6 dígitos, nada más.' };
  }
  try {
    await panel.ponerPin(userId, pin);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/equipo');
  return { ok: 'PIN puesto. Se lo pedirá cambiar la primera vez que entre.' };
}

/**
 * Emite un código de emparejamiento para una tablet.
 *
 * Es de **un solo uso y caduca**: el código ES la credencial con la que un
 * aparato sin cuenta entra al sistema, así que se enseña una vez y no se
 * guarda en ninguna pantalla. Quien lo pierde emite otro; quien lo deja
 * anotado en el mostrador ha dejado una llave.
 */
export async function emitirCodigo(
  _prev: EstadoEquipo,
  _form: FormData,
): Promise<EstadoEquipo> {
  try {
    const { code, expiresAt } = await panel.emitirCodigo();
    const caduca = new Date(expiresAt).toLocaleTimeString('es-PE', {
      timeZone: 'America/Lima',
      hour: '2-digit',
      minute: '2-digit',
    });
    // A propósito SIN `revalidatePath`: emitir un código no crea ningún
    // dispositivo —la fila nace cuando la tablet canjea—, así que no hay nada
    // que refrescar, y refrescar sí puede costar caro: el remontaje se llevaría
    // por delante el único momento en que el código se enseña.
    return {
      ok: `Código: ${code} — caduca a las ${caduca}. Escríbelo en la tablet ahora; no se vuelve a enseñar.`,
    };
  } catch (error) {
    return traducir(error);
  }
}

export async function revocarDispositivo(
  _prev: EstadoEquipo,
  form: FormData,
): Promise<EstadoEquipo> {
  const id = String(form.get('deviceId') ?? '');
  const reason = String(form.get('reason') ?? '').trim();
  // El motivo es obligatorio también en la API: una tablet revocada sin
  // explicación deja sin respuesta la pregunta de si se perdió o se rompió.
  if (reason.length < 3) {
    return { error: 'Di por qué se revoca: ¿perdida, rota, devuelta?' };
  }
  try {
    await panel.revocarDispositivo(id, reason);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/equipo');
  return { ok: 'Dispositivo revocado: deja de poder entrar ahora mismo.' };
}
