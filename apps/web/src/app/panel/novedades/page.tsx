import Link from 'next/link';
import { NOVEDADES } from './datos';
import { ordenadas } from './reglas';
import { MarcarLeidas } from './marcar';

/**
 * Novedades (specs/ux/03, docs/26).
 *
 * Es una pantalla de servidor y sin datos del negocio: las novedades son las
 * mismas para todos los clientes y viven en el repositorio, junto al código que
 * describen. Lo único que necesita el navegador es acordarse de hasta dónde
 * había leído, y de eso se encarga `MarcarLeidas`.
 */
export const metadata = { title: 'Novedades' };

function enEspanol(fecha: string): string {
  // `T12:00` y no la fecha a secas: `new Date('2026-08-22')` es medianoche UTC,
  // que en Lima es el día ANTERIOR por la tarde. Una novedad fechada un día
  // antes de lo que dice el archivo no es grave, pero es falso.
  return new Date(`${fecha}T12:00:00`).toLocaleDateString('es-PE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Lima',
  });
}

export default function NovedadesPage() {
  const lista = ordenadas(NOVEDADES);

  return (
    <>
      <h1>Novedades</h1>
      <p className="panel__subtitulo">
        Lo que puedes hacer ahora y antes no. De lo más reciente a lo más
        antiguo.
      </p>

      <MarcarLeidas />

      <ol className="novedades">
        {lista.map((n) => (
          <li key={`${n.fecha}-${n.titulo}`} className="novedad">
            <p className="novedad__fecha">
              <time dateTime={n.fecha}>{enEspanol(n.fecha)}</time>
            </p>
            <h2 className="novedad__titulo">{n.titulo}</h2>
            <p className="novedad__detalle">{n.detalle}</p>
            {/* Dónde se usa, como enlace. Una novedad que no dice dónde está
                obliga a buscarla por el menú, y a la tercera nadie las lee. */}
            {n.donde ? (
              <p className="tarjeta__pie">
                <Link href={n.donde}>{n.dondeRotulo ?? 'Ver'}</Link>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </>
  );
}
