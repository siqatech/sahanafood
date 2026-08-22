import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * El estado vacío (docs/25, principio 2: «cero estados vacíos muertos»).
 *
 * > todo vacío dice qué hacer a continuación con un botón.
 *
 * Antes de esto el panel tenía unos treinta `<p class="panel__vacio">` con una
 * frase suelta. La frase estaba bien escrita; el problema es que un panel recién
 * abierto es **casi todo estados vacíos**, y treinta callejones sin salida
 * seguidos hacen que el dueño cierre la pestaña. El sitio donde se descubre que
 * hay algo que hacer es justo el sitio donde no hay nada.
 *
 * ## Vacío por hacer ≠ vacío por buenas noticias
 *
 * La distinción que decide si esto ayuda o estorba:
 *
 *  · **«Aún no tienes platos»** es trabajo pendiente. Lleva acción.
 *  · **«Nadie debe efectivo»** es que todo está en orden. **No lleva acción**,
 *    y ponerle una —«registrar una deuda»— inventaría trabajo donde no lo hay,
 *    que es exactamente lo que un panel de operación no debe hacer a las once
 *    de la noche.
 *
 * Por eso `accion` es opcional y omitirla es una decisión, no un descuido.
 */

export interface AccionDeVacio {
  href: string;
  rotulo: string;
}

export function Vacio({
  titulo,
  children,
  accion,
  /** Buenas noticias: no falta nada, no hay nada que empujar. */
  enOrden = false,
}: {
  titulo: string;
  children?: ReactNode;
  accion?: AccionDeVacio | undefined;
  enOrden?: boolean;
}) {
  return (
    <div className={`vacio${enOrden ? ' vacio--en-orden' : ''}`}>
      <p className="vacio__titulo">{titulo}</p>
      {children ? <div className="vacio__texto">{children}</div> : null}
      {accion ? (
        <Link href={accion.href} className="boton-enlace">
          {accion.rotulo}
        </Link>
      ) : null}
    </div>
  );
}
