import Link from 'next/link';
import {
  panel,
  type MensajeDelPanel,
  type TrazaDeAgente,
  type RespuestaRapida,
} from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { Compositor, BotonTomar, BotonResolver } from '../formularios';
import {
  leerResolucion,
  herramientas,
  veredicto,
  resumirTrazas,
} from '../trazas';

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

  // Las trazas se degradan solas: leerlas exige `ai.read`, que quien atiende
  // puede no tener, y no poder auditar al bot no impide responderle al cliente.
  const [trazas, respuestas] = await Promise.all([
    panel.trazas(id).catch(() => [] as TrazaDeAgente[]),
    panel.respuestasDeConversacion(id).catch(() => [] as RespuestaRapida[]),
  ]);
  const cuentas = resumirTrazas(trazas);

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
        respuestas={respuestas}
      />
      <p className="tarjeta__pie">
        <Link href="/panel/conversaciones/respuestas">
          Escribir respuestas rápidas
        </Link>{' '}
        para lo que se repite cada día.
      </p>

      <div style={{ marginTop: 16 }}>
        <BotonResolver conversationId={conv.id} />
      </div>

      {trazas.length > 0 ? (
        /* Plegado por defecto: quien abre el hilo viene a contestar, no a
           auditar. Se abre solo cuando hay algo que mirar —una respuesta
           bloqueada o el presupuesto agotado— porque justo eso no se descubre
           si hay que acordarse de desplegarlo. */
        <details className="trazas" open={cuentas.aRevisar > 0}>
          <summary>
            Por qué contestó el asistente ({cuentas.turnos}{' '}
            {cuentas.turnos === 1 ? 'turno' : 'turnos'}
            {cuentas.aRevisar > 0 ? ` · ${cuentas.aRevisar} a revisar` : ''})
          </summary>

          <p className="tarjeta__pie">
            {cuentas.porRegla} de {cuentas.turnos} los resolvió una regla tuya
            —sin modelo y sin coste—. En total gastó {cuentas.creditos}{' '}
            {cuentas.creditos === 1 ? 'crédito' : 'créditos'}. Cuanto más suba
            la primera cifra, menos puede inventarse el asistente.
          </p>

          {trazas.map((t, i) => {
            const lectura = leerResolucion(t.resolution);
            const usadas = herramientas(t.toolsCalled);
            const validador = veredicto(t.validator);
            return (
              <article
                key={`${t.at}-${i}`}
                className={`ficha${lectura.tono === 'revision' ? ' ficha--revision' : ''}`}
              >
                <p>
                  <span className="etiqueta">{lectura.rotulo}</span>{' '}
                  <span className="tarjeta__pie">
                    {new Date(t.at).toLocaleString('es-PE', {
                      timeZone: 'America/Lima',
                    })}
                    {t.latencyMs !== null ? ` · ${t.latencyMs} ms` : ''}
                  </span>
                </p>
                <p className="tarjeta__pie">{lectura.explicacion}</p>

                <p className="tarjeta__rotulo">Le escribieron</p>
                <p>{t.inbound}</p>

                {t.outbound !== null ? (
                  <>
                    <p className="tarjeta__rotulo">
                      {/* En un bloqueo lo guardado es lo que el modelo QUERÍA
                          decir y no salió. Rotularlo «Contestó» sería mentir
                          sobre lo que el cliente llegó a ver. */}
                      {t.resolution === 'blocked'
                        ? 'Quería decir (no se envió)'
                        : 'Contestó'}
                    </p>
                    <p>{t.outbound}</p>
                  </>
                ) : null}

                <ul className="trazas__detalle">
                  {t.ruleId !== null ? (
                    <li>
                      Regla: <strong>{t.ruleName ?? 'borrada'}</strong>
                    </li>
                  ) : null}
                  {usadas.length > 0 ? (
                    <li>Consultó: {usadas.join(', ')}</li>
                  ) : null}
                  {t.sources > 0 ? (
                    <li>
                      Citó {t.sources}{' '}
                      {t.sources === 1 ? 'fuente tuya' : 'fuentes tuyas'}
                    </li>
                  ) : null}
                  {validador ? (
                    <li>
                      Validador:{' '}
                      {validador.ok
                        ? 'dejó pasar la respuesta'
                        : `la frenó — ${validador.motivo ?? 'sin motivo escrito'}`}
                    </li>
                  ) : null}
                  {t.promptVersion !== null ? (
                    <li className="tarjeta__pie">
                      Instrucciones {t.promptVersion}
                    </li>
                  ) : null}
                </ul>
              </article>
            );
          })}

          <p className="tarjeta__pie">
            Se guarda cada turno del asistente, incluidos los que no se
            enviaron. Si algo de aquí no debería haber salido, la respuesta casi
            siempre es una regla nueva en{' '}
            <Link href="/panel/agente">el agente</Link>: una regla gana siempre
            al modelo.
          </p>
        </details>
      ) : null}

      <p style={{ marginTop: 24 }}>
        <Link href="/panel/conversaciones">← Volver a la bandeja</Link>
      </p>
    </>
  );
}
