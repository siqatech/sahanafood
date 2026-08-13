/**
 * La etiqueta de canal, con SU color (docs/25 §Tokens).
 *
 * El sistema de diseño lo pide desde el principio y hasta ahora todos los
 * canales se pintaban con la misma píldora gris: en la torre de control, con
 * treinta tarjetas en pantalla, distinguir un pedido de Rappi de uno de la
 * tienda propia obligaba a leer palabra por palabra. Con color, el origen se
 * lee de un vistazo, que es exactamente para lo que existe esa pantalla.
 *
 * Los colores son los de la marca de cada canal a propósito —naranja Rappi,
 * rojo PedidosYa, verde WhatsApp—: el operador ya los tiene aprendidos de las
 * apps de esos canales, y contradecirlos costaría más de lo que aporta.
 *
 * El color NUNCA va solo: la píldora lleva siempre el nombre escrito (docs/25
 * §6, «sin información solo por color»). Quien no distingue el naranja del
 * rojo lee «rappi» igual.
 */

const CANALES: Record<string, { rotulo: string; clase: string }> = {
  web: { rotulo: 'Tienda web', clase: 'canal--propio' },
  pos: { rotulo: 'Mostrador', clase: 'canal--pos' },
  whatsapp: { rotulo: 'WhatsApp', clase: 'canal--whatsapp' },
  rappi: { rotulo: 'Rappi', clase: 'canal--rappi' },
  pedidosya: { rotulo: 'PedidosYa', clase: 'canal--pedidosya' },
};

/**
 * Un canal que no conocemos se pinta neutro y **con su identificador tal cual**.
 * Inventarle un nombre bonito a un canal nuevo escondería que el sistema no lo
 * reconoce, que es justo lo que hay que ver.
 */
export function Canal({ canal }: { canal: string }) {
  const c = CANALES[canal];
  return (
    <span className={c ? `etiqueta canal ${c.clase}` : 'etiqueta canal'}>
      {c ? c.rotulo : canal}
    </span>
  );
}
