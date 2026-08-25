import Link from 'next/link';
import { asuntosPendientes, type EntradaDeAtencion } from './atencion-reglas';

/**
 * «Necesita tu atención» en la portada.
 *
 * Es lo primero después del título porque es lo primero que hace falta: quien
 * abre el panel por la mañana no necesita saber cuánto vendió ayer —eso está
 * más abajo y no se puede cambiar—, necesita saber qué hay que arreglar hoy.
 *
 * **Desaparece cuando no hay nada.** No deja un «todo en orden» de consuelo: un
 * bloque que aparece siempre se deja de leer, y entonces tampoco se lee el día
 * que sí trae algo.
 */
export function NecesitaAtencion({ datos }: { datos: EntradaDeAtencion }) {
  const asuntos = asuntosPendientes(datos);
  if (asuntos.length === 0) return null;

  return (
    <section className="atencion" aria-labelledby="atencion-titulo">
      <h2 id="atencion-titulo" className="atencion__titulo">
        Necesita tu atención
      </h2>
      <ul className="atencion__lista">
        {asuntos.map((a) => (
          <li
            key={a.clave}
            className={
              a.urgente
                ? 'atencion__item atencion__item--urgente'
                : 'atencion__item'
            }
          >
            <Link href={a.href} className="atencion__enlace">
              {a.titulo}
            </Link>
            {/* La consecuencia, no solo el contador: «3 comprobantes
                rechazados» no mueve a nadie hasta que dice que son ventas que
                SUNAT no ha aceptado. */}
            <p className="atencion__consecuencia">{a.consecuencia}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
