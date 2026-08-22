import Link from 'next/link';
import type { ChecklistDeSalida } from '../../lib/panel-api';

/**
 * La checklist de salida en vivo (docs/26 §5, specs/ux/03: «persistente hasta
 * completarse»).
 *
 * docs/26 lo dice sin rodeos: «el churn temprano de POS se decide en el
 * onboarding, no en las features». Un dueño que entra por primera vez ve
 * catorce pantallas vacías y ninguna le dice **cuál es la siguiente**. La
 * métrica del proyecto es *alta → primera venta real en menos de un día*, y
 * hasta ahora el camino para llegar ahí solo existía en un documento.
 *
 * ## Tres decisiones
 *
 *  · **Desaparece sola al terminar.** «Persistente hasta completarse» significa
 *    exactamente eso: nada de un panel con una lista de tareas hechas ocupando
 *    la portada para siempre. Y no se puede cerrar antes: si se pudiera, se
 *    cerraría el primer día y la primera venta llegaría sin comprobante.
 *  · **Cada paso dice POR QUÉ, no «paso 3 de 6».** «Crea un cajero con su PIN»
 *    no convence a nadie; «sin PIN, un descuadre no tiene a quién preguntarle»
 *    sí. El número de paso no informa de nada que la barra no diga ya.
 *  · **Lo pendiente va PRIMERO.** Ordenar por el orden lógico deja al dueño
 *    leyendo cuatro cosas hechas antes de encontrar la que falta, y la que
 *    falta es la única razón por la que está mirando.
 */
export function ChecklistDeArranque({ datos }: { datos: ChecklistDeSalida }) {
  if (datos.listoParaAbrir) return null;

  // Pendientes primero, y dentro de cada grupo en su orden lógico. Lo opcional
  // al final del todo: no bloquea, así que compite mal por la atención.
  const orden = [...datos.pasos].sort((a, b) => {
    if (a.hecho !== b.hecho) return a.hecho ? 1 : -1;
    if (a.opcional !== b.opcional) return a.opcional ? 1 : -1;
    return 0;
  });
  const porcentaje = Math.round((datos.hechos / datos.obligatorios) * 100);

  return (
    <section className="arranque" aria-labelledby="arranque-titulo">
      <h2 id="arranque-titulo" className="arranque__titulo">
        Para abrir el local te faltan {datos.obligatorios - datos.hechos}{' '}
        {datos.obligatorios - datos.hechos === 1 ? 'cosa' : 'cosas'}
      </h2>
      <p className="tarjeta__pie">
        Son las que deciden si el primer día de venta sale bien. Esta lista
        desaparece sola cuando estén todas.
      </p>

      {/* La barra es decorativa; el progreso en palabras va al lado, porque
          una barra sin número no dice cuánto falta (docs/25 §6). */}
      <div className="arranque__barra">
        <div
          className="arranque__relleno"
          style={{ width: `${porcentaje}%` }}
          aria-hidden="true"
        />
      </div>
      <p className="tarjeta__pie">
        {datos.hechos} de {datos.obligatorios} listas
      </p>

      <ul className="arranque__pasos">
        {orden.map((p) => (
          <li
            key={p.id}
            className={`arranque__paso${p.hecho ? ' arranque__paso--hecho' : ''}`}
          >
            {/* El símbolo lleva texto para lector de pantalla: un «✓» suelto
                se lee como «marca de verificación» y no dice de qué. */}
            <span className="arranque__marca" aria-hidden="true">
              {p.hecho ? '✓' : '○'}
            </span>
            <span className="visualmente-oculto">
              {p.hecho ? 'Hecho: ' : 'Pendiente: '}
            </span>
            <span className="arranque__texto">
              {p.hecho ? (
                <strong>{p.titulo}</strong>
              ) : (
                <Link href={p.donde}>
                  <strong>{p.titulo}</strong>
                </Link>
              )}
              {p.opcional ? (
                <span className="etiqueta arranque__opcional">opcional</span>
              ) : null}
              {/* El porqué solo en lo pendiente: en lo hecho ya no convence de
                  nada y alarga la lista justo cuando quiere acortarse. */}
              {p.hecho ? null : (
                <span className="tarjeta__pie">{p.porQue}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
