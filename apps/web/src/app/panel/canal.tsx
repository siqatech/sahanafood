import { aspectoDeCanal } from '@sahana/ui';

/**
 * La etiqueta de canal, con SU color (docs/25 §Tokens).
 *
 * El sistema de diseño lo pide desde el principio y hasta hace poco todos los
 * canales se pintaban con la misma píldora gris: en la torre de control, con
 * treinta tarjetas en pantalla, distinguir un pedido de Rappi de uno de la
 * tienda propia obligaba a leer palabra por palabra.
 *
 * El rótulo y el color ya no se deciden aquí: vienen de `@sahana/ui`, porque
 * docs/25 los pide «usados consistentemente» en las tres apps y estaban escritos
 * solo en esta. El KDS no los tenía en absoluto, así que quien aprendía
 * «naranja = Rappi» mirando el panel llegaba a la cocina y encontraba todas las
 * comandas iguales.
 *
 * El color NUNCA va solo: la píldora lleva siempre el nombre escrito (docs/25
 * §6, «sin información solo por color»). Quien no distingue el naranja del rojo
 * lee «Rappi» igual.
 */
export function Canal({ canal }: { canal: string }) {
  const { rotulo, clase } = aspectoDeCanal(canal);
  return <span className={`etiqueta canal ${clase}`}>{rotulo}</span>;
}
