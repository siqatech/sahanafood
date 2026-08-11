import Link from 'next/link';
import {
  panel,
  type CapacidadDeCocina,
  type CargaDeCocina,
  type CambioDeNivel,
} from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { FormularioCapacidad } from './formularios';

/**
 * Capacidad de cocina (RN-KIT-04, spec 07).
 *
 * Es la pantalla que le da sentido a la de canales. La saturación pausa canales
 * sola, y hasta ahora **los umbrales que deciden cuándo solo se podían tocar por
 * API**: el dueño veía que su negocio dejaba de vender a las ocho y media sin
 * ningún sitio donde decir «aguanta hasta cuarenta platos».
 *
 * El histórico de niveles se guardaba desde T5.18 con el comentario «para
 * discutir el umbral con datos, no a ojo» — y no lo devolvía ninguna pantalla,
 * así que la discusión seguía siendo a ojo.
 */

const ROTULO_NIVEL: Record<string, string> = {
  normal: 'Normal',
  extended: 'Prometiendo más tarde',
  paused: 'Cerrando canales',
};

function momento(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function CocinaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const estructura = await cargar('/panel/cocina', yaSeIntento, () =>
    panel.estructura(),
  );
  const sugerido = await panel.ordenSugerido().catch((): string[] => []);

  // Una cocina puede no tener política todavía: se enseña igual, con los
  // valores por defecto, en vez de esconderla. Una cocina que no aparece se
  // lee como «esta no se satura nunca», que es justo lo contrario.
  const cocinas = await Promise.all(
    estructura.kitchens.map(async (k) => ({
      cocina: k,
      capacidad: await panel
        .capacidad(k.id)
        .catch((): CapacidadDeCocina | null => null),
      carga: await panel
        .cargaDeCocina(k.id)
        .catch((): CargaDeCocina | null => null),
      historial: await panel
        .historialDeSaturacion(k.id)
        .catch((): CambioDeNivel[] => []),
    })),
  );

  return (
    <>
      <h1>Cocina</h1>
      <p className="panel__subtitulo">
        Cuánto aguanta cada cocina antes de prometer más tarde, y cuánto antes
        de dejar de aceptar por un canal. Los canales cerrados se ven y se
        reabren en <Link href="/panel/operaciones">Operaciones</Link>.
      </p>

      {cocinas.length === 0 ? (
        <p className="panel__vacio">
          No hay cocinas dadas de alta todavía. Se crean con el alta del
          negocio.
        </p>
      ) : null}

      {cocinas.map(({ cocina, capacidad, carga, historial }) => (
        <section key={cocina.id}>
          <h2>
            {cocina.name}{' '}
            {capacidad ? (
              <span
                className={
                  capacidad.level === 'normal'
                    ? 'etiqueta'
                    : 'etiqueta etiqueta--pausado'
                }
              >
                {ROTULO_NIVEL[capacidad.level] ?? capacidad.level}
              </span>
            ) : null}
          </h2>

          {carga ? (
            <p className="tarjeta__pie">
              Ahora mismo: <strong>{carga.activeItems} platos</strong> en{' '}
              {carga.activeTickets} comandas
              {carga.lateTickets > 0 ? (
                <>
                  {' · '}
                  <strong className="baja">
                    {carga.lateTickets} fuera de tiempo
                  </strong>
                </>
              ) : null}
              {capacidad?.levelSince
                ? ` · en este nivel desde ${momento(capacidad.levelSince)}`
                : ''}
            </p>
          ) : null}

          {carga && carga.byStation.length > 0 ? (
            <div className="tabla-envoltorio">
              <table>
                <thead>
                  <tr>
                    <th>Estación</th>
                    <th>Comandas</th>
                    <th>Platos</th>
                    <th>La más antigua</th>
                  </tr>
                </thead>
                <tbody>
                  {carga.byStation.map((e) => (
                    <tr key={e.stationId}>
                      <td>{e.stationName}</td>
                      <td>{e.tickets}</td>
                      <td>{e.items}</td>
                      {/* El cuello de botella casi nunca es la cocina entera:
                          es una estación. Sin esta columna, subir el umbral
                          general es la respuesta equivocada a un horno lento. */}
                      <td>{e.oldestWaitingMinutes} min</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <h3>Umbrales</h3>
          <FormularioCapacidad
            kitchenId={cocina.id}
            actual={{
              maxConcurrentItems: capacidad?.maxConcurrentItems ?? 20,
              extendMinutes: capacidad?.extendMinutes ?? 15,
              pauseThresholdItems: capacidad?.pauseThresholdItems ?? null,
              channelPauseOrder: capacidad?.channelPauseOrder ?? [],
              enabled: capacidad?.enabled ?? true,
            }}
            sugerido={sugerido}
          />

          <h3>Qué ha pasado</h3>
          {historial.length === 0 ? (
            <p className="panel__vacio">
              Esta cocina no ha cambiado de nivel todavía.
            </p>
          ) : (
            <div className="tabla-envoltorio">
              <table>
                <thead>
                  <tr>
                    <th>Cuándo</th>
                    <th>Cambio</th>
                    <th>Platos</th>
                    <th>Qué hizo</th>
                  </tr>
                </thead>
                <tbody>
                  {historial.map((h, i) => (
                    <tr key={`${h.at}-${i}`}>
                      <td>{momento(h.at)}</td>
                      <td>
                        {ROTULO_NIVEL[h.fromLevel] ?? h.fromLevel} →{' '}
                        <strong>{ROTULO_NIVEL[h.toLevel] ?? h.toLevel}</strong>
                      </td>
                      <td>{h.activeItems}</td>
                      <td>
                        {h.ordersExtended > 0
                          ? `${h.ordersExtended} pedidos con la promesa alargada`
                          : ''}
                        {h.channelsPaused.length > 0 ? (
                          <>
                            {h.ordersExtended > 0 ? <br /> : null}
                            Cerró: {h.channelsPaused.join(', ')}
                          </>
                        ) : null}
                        {h.reason ? (
                          <>
                            <br />
                            <span className="tarjeta__pie">{h.reason}</span>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </>
  );
}
