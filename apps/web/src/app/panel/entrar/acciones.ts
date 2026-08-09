'use server';

import { redirect } from 'next/navigation';
import { panel, PanelApiError } from '../../../lib/panel-api';
import { guardarSesion } from '../../../lib/panel-session';

export interface EstadoAcceso {
  error?: string;
}

/**
 * Entrar al panel.
 *
 * El destino se limita a rutas **internas del panel**: llega por la URL, y una
 * redirección abierta convierte la pantalla de acceso en un trampolín para
 * llevarse a alguien a otro sitio justo después de escribir su contraseña.
 */
export async function entrar(
  _prev: EstadoAcceso,
  form: FormData,
): Promise<EstadoAcceso> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) {
    return { error: 'Escribe tu correo y tu contraseña.' };
  }

  const pedido = String(form.get('destino') ?? '');
  const destino = pedido.startsWith('/panel') ? pedido : '/panel';

  try {
    const tokens = await panel.entrar(email, password);
    await guardarSesion(tokens);
  } catch (error) {
    if (error instanceof PanelApiError) return { error: error.message };
    return { error: 'No hemos podido conectar. Inténtalo de nuevo.' };
  }
  // Fuera del try: Next implementa `redirect` lanzando, y atraparlo convertiría
  // un acceso correcto en un mensaje de error.
  redirect(destino);
}
