'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { NOVEDADES } from './novedades/datos';
import { CLAVE_ULTIMA_VISITA, sinLeer } from './novedades/reglas';

/**
 * La navegación del panel (specs/ux/03 «Estructura»).
 *
 * Antes eran **veintidós enlaces en una sola fila horizontal**, en el orden en
 * que se fueron construyendo las pantallas. Eso produce dos cosas: se sale de
 * la pantalla en cualquier portátil —«Histórico» quedaba cortado— y no dice
 * NADA de cómo se relacionan entre sí. Una lista de veintidós cosas no se lee,
 * se rastrea.
 *
 * Ahora van en columna y **agrupadas por la pregunta que responden**, que es el
 * orden de la spec: primero el día, luego lo que está pasando, luego el dinero,
 * luego lo que se vende, luego los clientes y al final lo que se configura una
 * vez y no se toca. Configuración va abajo a propósito: se entra a ella cinco
 * veces en la vida del negocio y a «Operaciones» cinco veces al día.
 */

interface Entrada {
  href: string;
  rotulo: string;
}

interface Grupo {
  titulo: string;
  entradas: Entrada[];
}

const GRUPOS: Grupo[] = [
  {
    titulo: 'Ahora',
    entradas: [
      { href: '/panel', rotulo: 'Hoy' },
      { href: '/panel/operaciones', rotulo: 'Operaciones' },
      { href: '/panel/cocina', rotulo: 'Cocina' },
      { href: '/panel/reparto', rotulo: 'Reparto' },
      { href: '/panel/excepciones', rotulo: 'Excepciones' },
    ],
  },
  {
    // «Atención» y no «Pedidos»: el enlace de dentro ya se llama así, y un
    // grupo con el mismo nombre que su única entrada principal no agrupa nada.
    titulo: 'Atención',
    entradas: [
      { href: '/panel/pedidos', rotulo: 'Pedidos' },
      { href: '/panel/conversaciones', rotulo: 'Conversaciones' },
      { href: '/panel/clientes', rotulo: 'Clientes' },
    ],
  },
  {
    titulo: 'Dinero',
    entradas: [
      { href: '/panel/caja', rotulo: 'Caja' },
      { href: '/panel/comprobantes', rotulo: 'Comprobantes' },
      { href: '/panel/pagos', rotulo: 'Cobros' },
      { href: '/panel/reportes', rotulo: 'Rentabilidad' },
    ],
  },
  {
    titulo: 'Qué vendes',
    entradas: [
      { href: '/panel/catalogo', rotulo: 'Carta' },
      { href: '/panel/inventario', rotulo: 'Inventario' },
      { href: '/panel/promociones', rotulo: 'Promociones' },
    ],
  },
  {
    titulo: 'Por dónde vendes',
    entradas: [
      { href: '/panel/canales', rotulo: 'Canales' },
      { href: '/panel/aspecto', rotulo: 'Aspecto de la tienda' },
      { href: '/panel/integracion', rotulo: 'API e integración' },
      { href: '/panel/agente', rotulo: 'Agente' },
      { href: '/panel/mensajeria', rotulo: 'Mensajería' },
    ],
  },
  {
    titulo: 'Configuración',
    entradas: [
      { href: '/panel/negocio', rotulo: 'Negocio' },
      { href: '/panel/equipo', rotulo: 'Equipo' },
      { href: '/panel/auditoria', rotulo: 'Histórico' },
      { href: '/panel/novedades', rotulo: 'Novedades' },
    ],
  },
];

/**
 * ¿Es esta la pantalla en la que estoy?
 *
 * `/panel` solo coincide EXACTO: con un `startsWith`, «Hoy» se quedaría
 * marcado en las veintiuna pantallas, que es exactamente igual de útil que no
 * marcar ninguna. El resto sí acepta subrutas, porque la ficha de un pedido
 * —`/panel/pedidos/<id>`— sigue siendo «Pedidos».
 */
function esActual(ruta: string, href: string): boolean {
  if (href === '/panel') return ruta === '/panel';
  return ruta === href || ruta.startsWith(`${href}/`);
}

/**
 * Cuántas novedades quedan sin leer en ESTE navegador.
 *
 * Empieza en cero y se calcula en `useEffect`: `localStorage` no existe en el
 * servidor, y pintarlo directo daría discrepancia de hidratación — el punto
 * parpadearía en cada carga.
 */
function useNovedadesSinLeer(): number {
  const [cuantas, setCuantas] = useState(0);

  useEffect(() => {
    const recalcular = (): void => {
      try {
        setCuantas(
          sinLeer(NOVEDADES, window.localStorage.getItem(CLAVE_ULTIMA_VISITA)),
        );
      } catch {
        // Sin `localStorage` no hay punto. Preferible a reventar la navegación.
        setCuantas(0);
      }
    };
    recalcular();
    // La pantalla de novedades avisa al marcarlas: sin esto el punto seguiría
    // ahí después de leerlas, que es como se aprende a ignorarlo.
    window.addEventListener('sahana:novedades-leidas', recalcular);
    return () =>
      window.removeEventListener('sahana:novedades-leidas', recalcular);
  }, []);

  return cuantas;
}

export function Navegacion() {
  const ruta = usePathname();
  const novedades = useNovedadesSinLeer();

  return (
    <nav className="panel__nav" aria-label="Secciones del panel">
      {GRUPOS.map((g) => (
        <div key={g.titulo} className="panel__grupo">
          <p className="panel__grupo-titulo">{g.titulo}</p>
          {g.entradas.map((e) => {
            const actual = esActual(ruta, e.href);
            return (
              <Link
                key={e.href}
                href={e.href}
                className={
                  actual
                    ? 'panel__enlace panel__enlace--actual'
                    : 'panel__enlace'
                }
                // `aria-current` y no solo el color: docs/25 §6 pide que ninguna
                // información viaje SOLO por color.
                aria-current={actual ? 'page' : undefined}
              >
                {e.rotulo}
                {/* El punto NUNCA va solo: lleva el número dentro y el texto
                    completo para lector de pantalla (docs/25 §6). */}
                {e.href === '/panel/novedades' && novedades > 0 ? (
                  <>
                    <span className="panel__punto" aria-hidden="true">
                      {novedades}
                    </span>
                    <span className="visualmente-oculto">
                      , {novedades} sin leer
                    </span>
                  </>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
