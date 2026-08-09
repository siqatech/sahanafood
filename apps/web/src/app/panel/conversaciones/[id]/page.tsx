import Link from 'next/link';
import { panel, type MensajeDelPanel } from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { Compositor, BotonTomar, BotonResolver } from '../formularios';

/**
 * El hilo de una conversación (specs/ux/06).
 *
 * Lo primero que se pinta —antes que el hilo— es el **resumen del bot**. No es
 * un adorno: es lo que la spec pide para que el agente conteste en menos de
 * diez segundos sin releerlo todo, y es exactamente el dato que se escribía
 * desde T5.28 y que ninguna ruta devolvía. Sin él, el humano abre con «hola,
 * ¿en qué puedo ayudarte?» y el cliente lo cuenta todo otra vez — que es el
 * momento exacto en el que la gente abandona.
 */

function autor(m: MensajeDelPanel): string {
  if (m.kind === 'note') return 'Nota interna';
  if (m.authorType === 'bot') return 'Asistente';
  if (m.authorType === 'agent') return 'Equipo';
  if (m.authorType === 'system') return 'Sistema';
  return 'Cliente';
}

function texto(m: MensajeDelPanel): string {
  const t = m.payload['text'];
  if (typeof t === 'string') return t;
  const plantilla = m.payload['templateName'];
  if (typeof plantilla === 'string') return `(plantilla ${plantilla})`;
  return '(sin texto)';
}

export default async function HiloPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const busqueda = await searchParams;
  const yaSeIntento = busqueda['intento'] === '1';
  const ruta = `/panel/conversaciones/${id}`;

  const [conv, mensajes, perfil] = await Promise.all([
    cargar(ruta, yaSeIntento, () => panel.conversacion(id)),
    cargar(ruta, yaSeIntento, () => panel.mensajes(id)),
    cargar(ruta, yaSeIntento, () => panel.perfil()),
  ]);

  const resumen = conv.handoffSummary;
  const capturados = Object.entries(resumen?.captured ?? {});

  return (
    <>
      <h1>{conv.contactName ?? conv.contactPhone}</h1>
      <p className="panel__subtitulo">
        {conv.brandName} · {conv.channel} · {conv.window.label}
        {conv.assigneeId ? '' : ' · sin asignar'}
      </p>

      {conv.handoffAt ? (
        <section className="ficha ficha--revision">
          <h2 style={{ marginTop: 0 }}>El bot te la pasó</h2>
          <p>
            <strong>Qué quiere:</strong> {resumen?.intent ?? 'no lo dejó claro'}
          </p>
          {capturados.length > 0 ? (
            <>
              <p className="tarjeta__rotulo">
                Ya te lo dijo — no lo repreguntes
              </p>
              <ul>
                {capturados.map(([clave, valor]) => (
                  <li key={clave}>
                    {clave}: <strong>{String(valor)}</strong>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {resumen?.notes ? (
            <p className="tarjeta__pie">{resumen.notes}</p>
          ) : null}
          {conv.assigneeId === null ? (
            <BotonTomar conversationId={conv.id} userId={perfil.userId} />
          ) : null}
        </section>
      ) : null}

      <h2>Hilo</h2>
      {mensajes.length === 0 ? (
        <p className="panel__vacio">Todavía no hay mensajes.</p>
      ) : (
        <div className="hilo">
          {mensajes.map((m) => (
            <div
              key={m.id}
              className={`burbuja burbuja--${m.kind === 'note' ? 'nota' : m.authorType}`}
            >
              {/* Autor SIEMPRE escrito, no solo posición o color: «¿esto lo
                  dijo la IA o una persona?» tiene que responderse sin
                  interpretar el diseño. */}
              <p className="tarjeta__rotulo">{autor(m)}</p>
              <p>{texto(m)}</p>
              <p className="tarjeta__pie">
                {new Date(m.createdAt).toLocaleString('es-PE', {
                  timeZone: 'America/Lima',
                })}
                {m.status !== 'sent' && m.direction === 'outbound'
                  ? ` · ${m.status}`
                  : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      <h2>Responder</h2>
      <Compositor
        conversationId={conv.id}
        puedeTextoLibre={conv.window.canSendFreeform}
        etiquetaDeVentana={conv.window.label}
      />

      <div style={{ marginTop: 16 }}>
        <BotonResolver conversationId={conv.id} />
      </div>

      <p style={{ marginTop: 24 }}>
        <Link href="/panel/conversaciones">← Volver a la bandeja</Link>
      </p>
    </>
  );
}
