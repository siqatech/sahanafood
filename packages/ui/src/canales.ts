/**
 * El vocabulario de canales: cómo se llama cada uno y de qué color va.
 *
 * Va junto a `canales.css` y en el mismo paquete porque **el rótulo y el color
 * son el mismo hecho**: si el panel dice «Tienda web» en verde y el KDS dijera
 * «web» en gris, el operador tendría que aprender dos veces la misma cosa. Esto
 * estaba escrito solo en `apps/web/src/app/panel/canal.tsx` y el KDS ni siquiera
 * enseñaba el canal.
 *
 * Es una tabla de PRESENTACIÓN, no de dominio: el identificador del canal —el
 * que viaja en el pedido, se guarda en la base y decide el precio— vive en
 * `@sahana/domain` y en la base de datos. Aquí solo está cómo se enseña.
 */

export interface AspectoDeCanal {
  /** Cómo se llama en pantalla, en español y como lo diría el operador. */
  rotulo: string;
  /** La clase CSS de `canales.css`. */
  clase: string;
}

const CANALES: Record<string, AspectoDeCanal> = {
  web: { rotulo: 'Tienda web', clase: 'canal--propio' },
  pos: { rotulo: 'Mostrador', clase: 'canal--pos' },
  whatsapp: { rotulo: 'WhatsApp', clase: 'canal--whatsapp' },
  rappi: { rotulo: 'Rappi', clase: 'canal--rappi' },
  pedidosya: { rotulo: 'PedidosYa', clase: 'canal--pedidosya' },
};

/**
 * Cómo se enseña un canal.
 *
 * Uno que no conocemos se pinta neutro y **con su identificador tal cual**.
 * Inventarle un nombre bonito a un canal nuevo escondería que el sistema no lo
 * reconoce, que es justo lo que hay que ver: un pedido cuyo origen no sabemos
 * es el que más falta hace mirar.
 */
export function aspectoDeCanal(canal: string): AspectoDeCanal {
  return CANALES[canal] ?? { rotulo: canal, clase: 'canal--otro' };
}

/** Los canales con nombre propio, para pintar filtros. */
export function canalesConocidos(): Array<{ id: string } & AspectoDeCanal> {
  return Object.entries(CANALES).map(([id, a]) => ({ id, ...a }));
}
