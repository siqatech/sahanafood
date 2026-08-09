import Link from 'next/link';
import { panel, type ConversacionDelPanel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';

/**
 * Bandeja de conversaciones (specs/ux/06) — paga **DT-14**.
 *
 * El módulo de conversaciones y el agente de IA estaban completos y probados
 * desde T5.19–T5.31. Lo que no existía era esto: la pantalla donde una persona
 * atiende. La consecuencia concreta no era estética — **una derivación
 * bot→humano no llegaba a ningún sitio**. El agente escribía el resumen,
 * marcaba `handoff_at` y ahí se quedaba. El cliente que pidió hablar con
 * alguien no recibía respuesta, justo después de que el sistema hiciera todo
 * lo correcto.
 *
 * Por eso las DERIVADAS van arriba y no ordenadas por fecha con el resto: son
 * las únicas donde ya hay alguien esperando a una persona concreta.
 */

function cuando(iso: string | null): string {
  if (!iso) return 'sin mensajes';
  return new Date(iso).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Fila({ c }: { c: ConversacionDelPanel }) {
  return (
    <article className={`ficha${c.handoffAt ? ' ficha--revision' : ''}`}>
      <p>
        <strong>{c.contactName ?? c.contactPhone}</strong>{' '}
        <span className="etiqueta">{c.channel}</span>{' '}
        <span className="etiqueta">{c.brandName}</span>
      </p>
      <p className="tarjeta__pie">
        {/* La ventana la redacta el dominio, no esta pantalla: es la misma
            frase que ve cualquier otro cliente de la API (RN-CNV-03). */}
        {c.window.label} · {c.messageCount} mensajes · {cuando(c.lastMsgAt)}
      </p>
      {c.handoffAt ? (
        <p className="tarjeta__pie">
          <strong>Derivada por el bot:</strong>{' '}
          {c.handoffSummary?.intent ?? 'sin resumen'}
        </p>
      ) : null}
      <Link href={`/panel/conversaciones/${c.id}`}>Abrir →</Link>
    </article>
  );
}

export default async function ConversacionesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const busqueda =
    typeof params['q'] === 'string' && params['q'] !== ''
      ? params['q']
      : undefined;

  // No se filtra por estado en la API sino que se descartan las resueltas
  // aquí. La API acepta UN estado y una bandeja necesita tres —`bot`,
  // `waiting_human` y `assigned`—; pedir uno solo escondería justo las
  // derivadas, que son las que hay que ver. El límite del servidor es 200, así
  // que traerlas todas y quitar las cerradas cuesta lo mismo.
  const todas = await cargar('/panel/conversaciones', yaSeIntento, () =>
    panel.conversaciones(busqueda !== undefined ? { search: busqueda } : {}),
  );
  const abiertas = todas.filter((c) => c.status !== 'resolved');

  const derivadas = abiertas.filter((c) => c.handoffAt !== null);
  const resto = abiertas.filter((c) => c.handoffAt === null);

  return (
    <>
      <h1>Conversaciones</h1>
      <p className="panel__subtitulo">
        Lo que están escribiendo los clientes. Las que el bot derivó a una
        persona van primero: ahí ya hay alguien esperando.
      </p>

      <form className="en-linea" method="get">
        <input
          name="q"
          placeholder="Buscar por teléfono, nombre o texto"
          aria-label="Buscar conversaciones"
          defaultValue={busqueda ?? ''}
        />
        <button type="submit">Buscar</button>
      </form>

      {derivadas.length > 0 ? (
        <>
          <h2>Esperando a una persona ({derivadas.length})</h2>
          {derivadas.map((c) => (
            <Fila key={c.id} c={c} />
          ))}
        </>
      ) : null}

      <h2>Abiertas</h2>
      {resto.length === 0 ? (
        <p className="panel__vacio">
          {busqueda
            ? 'Nada coincide con esa búsqueda.'
            : 'No hay conversaciones abiertas ahora mismo.'}
        </p>
      ) : (
        resto.map((c) => <Fila key={c.id} c={c} />)
      )}
    </>
  );
}
