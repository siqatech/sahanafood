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
