import { nivelDeTiempo, type NivelDeTiempo } from '@sahana/domain';
import { aspectoDeCanal } from '@sahana/ui';
import type { TicketDeCocina } from '../lib/api';

/**
 * La tarjeta de comanda del KDS (ux/02, docs/25).
 *
 * Vive aparte de `cocina.tsx` por una razón de prueba y no de orden: la
 * pantalla pide la cola, la refresca cada cinco segundos y mantiene el
 * deshacer; la tarjeta solo pinta lo que le dan. Separadas, **lo que se ve se
 * puede comprobar sin simular la API** (ADR-0021), y eso importa aquí más que
 * en ninguna otra pantalla: la banda de alérgenos es el único aviso del
 * producto cuyo fallo no se mide en dinero.
 *
 * No hace peticiones ni conoce el token. Todo entra por props.
 */

/**
 * Semáforo de tiempo. La REGLA vive en `@sahana/domain`.
 *
 * Estaba escrita aquí y otra vez en el panel, con dos criterios distintos: allí
 * era un umbral fijo de dos minutos, que con una promesa de treinta avisa al
 * 93 % del plazo. Dos pantallas discrepando sobre el mismo pedido es peor que
 * cualquiera de las dos por separado.
 *
 * `late` manda sobre el cálculo: lo dice el servidor, que sabe si la promesa se
 * extendió por saturación (RN-KIT-04). El reloj de una tablet no.
 */
export function semaforo(
  t: TicketDeCocina,
  ahora: number = Date.now(),
): NivelDeTiempo {
  if (t.late) return 'rojo';
  if (!t.promisedAt) return 'verde';
  return nivelDeTiempo({
    inicio: Date.parse(t.createdAt),
    limite: Date.parse(t.promisedAt),
    ahora,
  });
}

export function TarjetaDeComanda({
  ticket,
  avanzable,
  onAvanzar,
}: {
  ticket: TicketDeCocina;
  /** Si la columna tiene siguiente estado. «Listos» no avanza a ningún sitio. */
  avanzable: boolean;
  onAvanzar: (t: TicketDeCocina) => void;
}) {
  return (
    <button
      type="button"
      className={`comanda comanda--${semaforo(ticket)}`}
      onClick={() => {
        onAvanzar(ticket);
      }}
      disabled={!avanzable}
    >
      <div className="comanda__cabecera">
        <span className="comanda__numero">#{ticket.orderNumber}</span>
        <span className="comanda__marca">{ticket.brandName}</span>
        {/* El canal, con su color (docs/25). En una cocina oscura con cuatro
            marcas y cuatro canales, «de dónde vino» decide qué se cocina antes:
            el repartidor de Rappi está esperando en la puerta y el pedido web
            es programado. El nombre va escrito, nunca solo el color. */}
        <span className={`canal ${aspectoDeCanal(ticket.channel).clase}`}>
          {ticket.channel === ''
            ? 'origen desconocido'
            : aspectoDeCanal(ticket.channel).rotulo}
        </span>
      </div>
      <ul className="comanda__lineas">
        {ticket.lines.map((l) => (
          <li key={l.id}>
            <strong>{l.quantity}×</strong> {l.productName}
            {l.modifiersText ? (
              <div className="comanda__modificadores">{l.modifiersText}</div>
            ) : null}
            {/* Las notas NO se pueden ignorar: fondo amarillo y tamaño mayor,
                como pide docs/25. */}
            {l.notes ? <div className="comanda__nota">{l.notes}</div> : null}
            {/* Banda ROJA de alérgenos (docs/25). Solo cuando hay alguno: una
                banda en cada línea se deja de ver, y entonces no se ve la que
                importa.

                Un `null` —comanda vieja, sin dato— NO pinta nada: decir «sin
                alérgenos» sobre algo que no se registró sería inventar una
                inocuidad que nadie afirmó. */}
            {l.allergens && l.allergens.length > 0 ? (
              <div className="comanda__alergenos">
                ⚠ {l.allergens.join(', ')}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="comanda__pie">
        <span>{ticket.waitingMinutes} min</span>
        <span>{ticket.stationName}</span>
      </div>
    </button>
  );
}
