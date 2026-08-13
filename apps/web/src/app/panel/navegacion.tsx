'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

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

export function Navegacion() {
  const ruta = usePathname();

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
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
