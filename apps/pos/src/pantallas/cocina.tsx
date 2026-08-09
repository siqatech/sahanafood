import { useCallback, useEffect, useState } from 'react';
import { api, SinRed, type TicketDeCocina } from '../lib/api';

/**
 * KDS: la pantalla de la cocina (ux/02).
 *
 * Se lee a dos metros, con las manos ocupadas y con ruido. De ahí todo lo
 * demás: tema oscuro de alto contraste, número de pedido enorme, columnas por
 * estado y **un toque en la tarjeta para avanzar**, con objetivos de 64 px.
 *
 * Dos reglas de la spec que se cumplen aquí y conviene señalar:
 *
 *  · **Nunca una pantalla en blanco.** Si se cae la red, se enseña un aviso y
 *    la cola que ya estaba, no un error. Una cocina sin comandas a la vista se
 *    para; una cocina con comandas de hace treinta segundos, no.
 *  · **Deshacer durante 8 s.** Un toque accidental con el codo pasa, y sin
 *    deshacer el cocinero tiene que buscar al encargado en mitad del servicio.
 *    Deshace **de verdad**: el ticket retrocede y, si el pedido había pasado a
 *    «listo» por ese toque, vuelve a preparación con él. Quien decide si se
 *    puede es el servidor —hay ventana de tiempo y el pedido tiene que seguir
 *    en cocina—; el reloj de una tablet no es una autorización.
 */

const REFRESCO_MS = 5_000;
/** Cuánto se ofrece deshacer, como pide ux/02. El servidor da algo más de
 *  margen para que un desfase de reloj no invalide un deshacer legítimo. */
const DESHACER_MS = 8_000;

const COLUMNAS = [
  { estado: 'queued', rotulo: 'Nuevos', siguiente: 'start' as const },
  {
    estado: 'in_progress',
    rotulo: 'En preparación',
    siguiente: 'ready' as const,
  },
  { estado: 'ready', rotulo: 'Listos', siguiente: null },
];

/** Semáforo de tiempo: verde <70 % del prometido, ámbar hasta el 100 %, rojo pasado. */
function semaforo(t: TicketDeCocina): string {
  if (t.late) return 'rojo';
  if (!t.promisedAt) return 'verde';
  const total = Date.parse(t.promisedAt) - Date.parse(t.createdAt);
  if (total <= 0) return 'ambar';
  const transcurrido = Date.now() - Date.parse(t.createdAt);
  return transcurrido / total >= 0.7 ? 'ambar' : 'verde';
}

export function Cocina({
  token,
  kitchenId,
}: {
  token: string;
  kitchenId: string;
}) {
  const [tickets, setTickets] = useState<TicketDeCocina[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ultimo, setUltimo] = useState<{
    ticketId: string;
    numero: number;
    hasta: number;
  } | null>(null);
  const [deshaciendo, setDeshaciendo] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const cola = await api.cola(token, { kitchenId });
      setTickets(cola);
      setAviso(null);
    } catch (error) {
      // NO se vacía la lista. Enseñar la cola de hace treinta segundos es
      // infinitamente mejor que enseñar nada: la cocina sigue trabajando.
      setAviso(
        error instanceof SinRed
          ? 'Sin conexión — mostrando la última cola recibida.'
          : 'No se pudo actualizar la cola.',
      );
    }
  }, [token, kitchenId]);

  useEffect(() => {
    void cargar();
    const id = setInterval(() => {
      void cargar();
    }, REFRESCO_MS);
    return () => {
      clearInterval(id);
    };
  }, [cargar]);

  async function avanzar(t: TicketDeCocina): Promise<void> {
    const columna = COLUMNAS.find((c) => c.estado === t.status);
    if (!columna?.siguiente) return;
    try {
      await api.avanzarTicket(token, t.id, columna.siguiente);
      setUltimo({
        ticketId: t.id,
        numero: t.orderNumber,
        hasta: Date.now() + DESHACER_MS,
      });
      await cargar();
    } catch {
      setAviso('No se pudo avanzar el ticket. Vuelve a tocarlo.');
    }
  }

  async function deshacer(ticketId: string): Promise<void> {
    setDeshaciendo(true);
    try {
      await api.deshacerTicket(token, ticketId);
      setUltimo(null);
      await cargar();
    } catch (error) {
      // El motivo viene del servidor y es el que importa: «pasó el tiempo» y
      // «el pedido ya salió de cocina» se resuelven de formas distintas.
      setAviso(
        error instanceof Error
          ? error.message
          : 'No se pudo deshacer. Avisa al encargado.',
      );
      setUltimo(null);
    } finally {
      setDeshaciendo(false);
    }
  }

  return (
    <div className="kds">
      {aviso ? <div className="kds__aviso">{aviso}</div> : null}
      <div className="kds__columnas">
        {COLUMNAS.map((c) => {
          const suyos = tickets.filter((t) => t.status === c.estado);
          return (
            <section key={c.estado} className="kds__columna">
              <h2>
                {c.rotulo} <span className="kds__cuenta">{suyos.length}</span>
              </h2>
              {suyos.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`comanda comanda--${semaforo(t)}`}
                  onClick={() => {
                    void avanzar(t);
                  }}
                  disabled={c.siguiente === null}
                >
                  <div className="comanda__cabecera">
                    <span className="comanda__numero">#{t.orderNumber}</span>
                    <span className="comanda__marca">{t.brandName}</span>
                  </div>
                  <ul className="comanda__lineas">
                    {t.lines.map((l) => (
                      <li key={l.id}>
                        <strong>{l.quantity}×</strong> {l.productName}
                        {l.modifiersText ? (
                          <div className="comanda__modificadores">
                            {l.modifiersText}
                          </div>
                        ) : null}
                        {/* Las notas NO se pueden ignorar: fondo amarillo y
                            tamaño mayor, como pide docs/25. */}
                        {l.notes ? (
                          <div className="comanda__nota">{l.notes}</div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <div className="comanda__pie">
                    <span>{t.waitingMinutes} min</span>
                    <span>{t.stationName}</span>
                  </div>
                </button>
              ))}
              {suyos.length === 0 ? (
                <p className="kds__vacio">Nada aquí.</p>
              ) : null}
            </section>
          );
        })}
      </div>
      {ultimo && ultimo.hasta > Date.now() ? (
        <div className="kds__confirmacion">
          <span>#{ultimo.numero} avanzado</span>
          <button
            type="button"
            disabled={deshaciendo}
            onClick={() => {
              void deshacer(ultimo.ticketId);
            }}
          >
            {deshaciendo ? 'Deshaciendo…' : 'Deshacer'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
