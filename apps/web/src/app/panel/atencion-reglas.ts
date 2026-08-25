/**
 * Lo que necesita tu atención hoy (specs/ux/03, docs/25).
 *
 * ## Por qué existe
 *
 * El trabajo pendiente estaba repartido en cinco pantallas —Excepciones,
 * Comprobantes, Caja, Inventario— y ninguna se abre sola. Un pedido apartado se
 * descubría al entrar en Excepciones, y a Excepciones se entra cuando ya
 * sospechas que hay algo. La portada decía cuánto se vendió, que es mirar hacia
 * atrás, y no decía qué hay que hacer, que es lo que se necesita al abrir el
 * panel por la mañana.
 *
 * ## Por qué NO es un aviso más
 *
 * Va en la portada, donde ya vive la checklist de arranque, y no en una banda
 * nueva en todas las pantallas. Dos sitios distintos diciendo «haz esto ahora»
 * compiten entre ellos: al tercer día se ignoran los dos. Uno, y en el sitio al
 * que se entra primero.
 *
 * ## El orden importa y por eso se prueba
 *
 * No es alfabético ni por cantidad: es por **quién está esperando**.
 */

export type ClaveDeAtencion =
  'excepciones' | 'comprobantes' | 'caja' | 'inventario';

export interface AsuntoPendiente {
  clave: ClaveDeAtencion;
  /** Cuántos. Va en el rótulo porque «3 pedidos» y «40» no se atienden igual. */
  cuantos: number;
  titulo: string;
  /** Qué pasa si no se hace nada. Sin esto, un contador es solo un número. */
  consecuencia: string;
  href: string;
  /** `true` cuando hay alguien esperando AHORA MISMO. */
  urgente: boolean;
}

export interface EntradaDeAtencion {
  pedidosApartados: number;
  comprobantesRechazados: number;
  /** Turnos de caja abiertos que NO son de hoy. */
  cajasSinCerrar: number;
  insumosBajoMinimo: number;
}

/**
 * El orden es por quién espera, de más a menos:
 *
 *  1. **Pedido apartado.** Hay una persona con hambre esperando una respuesta
 *     que nadie le ha dado. Se mide en minutos.
 *  2. **Comprobante rechazado.** Es una venta hecha que no está declarada. Se
 *     mide en horas y tiene consecuencia legal, pero nadie está esperando al
 *     teléfono.
 *  3. **Caja de otro día sin cerrar.** Ya está mal y no puede empeorar: el
 *     recuento de ese día es irrecuperable. Urgente NO, importante sí.
 *  4. **Insumo bajo mínimo.** Todavía no ha pasado nada. Es el único que avisa
 *     ANTES del problema, y por eso va el último.
 */
export function asuntosPendientes(e: EntradaDeAtencion): AsuntoPendiente[] {
  const todos: AsuntoPendiente[] = [
    {
      clave: 'excepciones',
      cuantos: e.pedidosApartados,
      titulo:
        e.pedidosApartados === 1
          ? 'Un pedido esperando que alguien lo mire'
          : `${e.pedidosApartados} pedidos esperando que alguien los mire`,
      consecuencia:
        'Llegaron con algo que no cuadra y no han entrado a cocina. El cliente sigue esperando.',
      href: '/panel/excepciones',
      urgente: true,
    },
    {
      clave: 'comprobantes',
      cuantos: e.comprobantesRechazados,
      titulo:
        e.comprobantesRechazados === 1
          ? 'Un comprobante rechazado'
          : `${e.comprobantesRechazados} comprobantes rechazados`,
      consecuencia:
        'Son ventas hechas que SUNAT no ha aceptado. Hasta corregirlas, no están declaradas.',
      href: '/panel/comprobantes',
      urgente: false,
    },
    {
      clave: 'caja',
      cuantos: e.cajasSinCerrar,
      titulo:
        e.cajasSinCerrar === 1
          ? 'Una caja de otro día sin cerrar'
          : `${e.cajasSinCerrar} cajas de otros días sin cerrar`,
      consecuencia:
        'El arqueo de ese día ya no se puede cuadrar bien. Ciérrala para que no arrastre al de hoy.',
      href: '/panel/caja',
      urgente: false,
    },
    {
      clave: 'inventario',
      cuantos: e.insumosBajoMinimo,
      titulo:
        e.insumosBajoMinimo === 1
          ? 'Un insumo por debajo del mínimo'
          : `${e.insumosBajoMinimo} insumos por debajo del mínimo`,
      consecuencia:
        'Todavía hay, pero para poco. Es el único aviso que llega antes del problema.',
      href: '/panel/inventario',
      urgente: false,
    },
  ];

  // Solo lo que de verdad hay: una lista con «0 pedidos apartados» enseña a
  // ignorar el bloque entero, y entonces no sirve el día que sí hay algo.
  return todos.filter((a) => a.cuantos > 0);
}

/** ¿Hay algo que atender? Para decidir si el bloque se pinta siquiera. */
export function hayAlgoQueAtender(e: EntradaDeAtencion): boolean {
  return asuntosPendientes(e).length > 0;
}
