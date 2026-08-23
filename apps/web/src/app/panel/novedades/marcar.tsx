'use client';

import { useEffect } from 'react';
import { NOVEDADES } from './datos';
import { CLAVE_ULTIMA_VISITA, fechaMasReciente } from './reglas';

/**
 * Deja constancia, en ESTE navegador, de que ya se leyeron.
 *
 * No pinta nada: solo escribe. Se ejecuta al abrir la pantalla y no al salir,
 * porque «salir» no siempre ocurre —se cierra la pestaña, se apaga la tablet— y
 * un aviso que no se apaga nunca enseña a ignorarlo.
 *
 * Todo dentro de `try`: `localStorage` lanza en pestaña privada, con las cookies
 * de sitio bloqueadas y en algunos navegadores empotrados. Que no se pueda
 * recordar la visita no puede tumbar la pantalla que se estaba mirando.
 */
export function MarcarLeidas() {
  useEffect(() => {
    const reciente = fechaMasReciente(NOVEDADES);
    if (!reciente) return;
    try {
      window.localStorage.setItem(CLAVE_ULTIMA_VISITA, reciente);
      // La navegación avisa para quitar el punto sin recargar: es la misma
      // pestaña, y un aviso que sigue ahí después de leer parece roto.
      window.dispatchEvent(new Event('sahana:novedades-leidas'));
    } catch {
      // Sin `localStorage` el punto reaparecerá. Es el peor caso y es aceptable.
    }
  }, []);

  return null;
}
