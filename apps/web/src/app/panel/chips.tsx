import Link from 'next/link';

/**
 * Filtros por chips (specs/ux/03: «todo listado: filtros por chips»).
 *
 * Son ENLACES, no botones con JavaScript, y eso trae tres cosas gratis: el
 * filtro queda en la URL —así se comparte «mírame los cancelados de hoy» por
 * WhatsApp—, el botón de atrás del navegador funciona, y la pantalla sigue
 * filtrando sin JavaScript.
 *
 * Cada chip conserva el resto de la consulta. Sin eso, filtrar por canal
 * borraría el texto que alguien acaba de escribir en el buscador, que es la
 * forma más rápida de que un filtro deje de usarse.
 */

export interface Chip {
  /** Valor del parámetro. Cadena vacía = «todos», que es quitar el filtro. */
  valor: string;
  rotulo: string;
  /** Cuántos hay. Se omite cuando contarlos costaría una consulta más. */
  cuenta?: number | undefined;
}

export function Chips({
  nombre,
  actual,
  opciones,
  base,
  otros,
  etiqueta,
}: {
  /** Parámetro de la URL que gobierna este grupo, p. ej. `estado`. */
  nombre: string;
  actual: string;
  opciones: Chip[];
  /** Ruta de la pantalla, sin consulta. */
  base: string;
  /** El resto de parámetros vivos, para no perderlos al pulsar. */
  otros: Record<string, string>;
  etiqueta: string;
}) {
  const href = (valor: string): string => {
    const params = new URLSearchParams(otros);
    // El valor vacío QUITA el parámetro en vez de mandarlo vacío: así la URL de
    // «todos» es la de la pantalla sin filtros, y no una con `?estado=`.
    if (valor !== '') params.set(nombre, valor);
    const cadena = params.toString();
    return cadena === '' ? base : `${base}?${cadena}`;
  };

  return (
    <div className="chips" role="group" aria-label={etiqueta}>
      {opciones.map((o) => {
        const activo = o.valor === actual;
        return (
          <Link
            key={o.valor || 'todos'}
            href={href(o.valor)}
            className={activo ? 'chip chip--activo' : 'chip'}
            // No solo el color: `aria-current` es lo que hace que un lector de
            // pantalla diga cuál está puesto (docs/25 §6).
            aria-current={activo ? 'true' : undefined}
          >
            {o.rotulo}
            {o.cuenta !== undefined ? (
              <span className="chip__cuenta">{o.cuenta}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
