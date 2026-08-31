'use client';

import { useActionState } from 'react';
import {
  crearLocal,
  crearMarca,
  crearCocina,
  crearEstacion,
  unirMarcaACocina,
  guardarHorario,
  anadirFeriado,
  quitarFeriado,
  type EstadoNegocio,
} from './acciones';
import { DIAS } from './horario';

function Resultado({ estado }: { estado: EstadoNegocio }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function FormularioMarca({ companyId }: { companyId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    crearMarca,
    {},
  );
  return (
    <form action={accion} className="ficha">
      <h2 style={{ marginTop: 0 }}>Añadir una marca</h2>
      <Resultado estado={estado} />
      <input type="hidden" name="companyId" value={companyId} />
      <div className="campo">
        <label htmlFor="marca-nombre">Nombre comercial</label>
        <input id="marca-nombre" name="name" required />
        <p className="tarjeta__pie">
          Es el nombre que ve el cliente. Varias marcas pueden producirse en la
          misma cocina: eso es una dark kitchen.
        </p>
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Creando…' : 'Crear marca'}
      </button>
    </form>
  );
}

export function FormularioLocal({ companyId }: { companyId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    crearLocal,
    {},
  );
  return (
    <form action={accion} className="ficha">
      <h2 style={{ marginTop: 0 }}>Añadir un local</h2>
      <Resultado estado={estado} />
      <input type="hidden" name="companyId" value={companyId} />
      <div className="campo">
        <label htmlFor="local-nombre">Nombre</label>
        <input id="local-nombre" name="name" required />
      </div>
      <div className="campo">
        <label htmlFor="local-direccion">Dirección</label>
        <input id="local-direccion" name="address" required />
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Creando…' : 'Crear local'}
      </button>
    </form>
  );
}

/**
 * El horario semanal del local (RN-ORG-03).
 *
 * Siete filas con dos horas cada una y nada más. Dejar un día vacío es
 * **cerrarlo**, y lo dice en pantalla: es el caso que más se usa después de la
 * semana completa, y en un desplegable de «abierto/cerrado» habría que tocar
 * dos controles para lo mismo.
 *
 * El formulario manda los siete días SIEMPRE, porque el guardado reemplaza el
 * horario entero. Y lleva los feriados escondidos para reenviarlos tal cual:
 * perderlos al cambiar la hora de los martes abriría el local un 28 de julio.
 */
export function FormularioHorario({
  locationId,
  weekly,
  feriados,
}: {
  locationId: string;
  weekly: Array<{ weekday: number; opensAt: string; closesAt: string }>;
  feriados: Array<{
    date: string;
    ranges: Array<{ opensAt: string; closesAt: string }>;
  }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    guardarHorario,
    {},
  );
  const porDia = new Map(weekly.map((f) => [f.weekday, f]));

  return (
    <form action={accion} className="ficha">
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="feriados" value={JSON.stringify(feriados)} />
      <div className="tabla-envoltorio">
        <table>
          <thead>
            <tr>
              <th>Día</th>
              <th>Abre</th>
              <th>Cierra</th>
            </tr>
          </thead>
          <tbody>
            {DIAS.map((d) => {
              const f = porDia.get(d.indice);
              return (
                <tr key={d.indice}>
                  <td>
                    {d.nombre}
                    {!f ? (
                      <>
                        {' '}
                        <span className="etiqueta">cerrado</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <input
                      type="time"
                      name={`abre-${d.indice}`}
                      defaultValue={f?.opensAt ?? ''}
                      aria-label={`${d.nombre}: hora de apertura`}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      name={`cierra-${d.indice}`}
                      defaultValue={f?.closesAt ?? ''}
                      aria-label={`${d.nombre}: hora de cierre`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="tarjeta__pie">
        Un día sin horas está cerrado. Cerrar después de medianoche vale: 18:00
        a 02:00 es una jornada, no un error.
      </p>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Guardando…' : 'Guardar el horario'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

/**
 * Feriados y jornadas especiales.
 *
 * Una excepción REEMPLAZA al horario de esa fecha, no se le suma — lo decide
 * `@sahana/domain` y por eso se dice aquí: sin horas, cerrado todo el día.
 */
export function FormularioFeriado({
  locationId,
  weekly,
  feriados,
}: {
  locationId: string;
  weekly: Array<{ weekday: number; opensAt: string; closesAt: string }>;
  feriados: Array<{
    date: string;
    ranges: Array<{ opensAt: string; closesAt: string }>;
  }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    anadirFeriado,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="locationId" value={locationId} />
        <input type="hidden" name="semana" value={JSON.stringify(weekly)} />
        <input type="hidden" name="feriados" value={JSON.stringify(feriados)} />
        <input type="date" name="fecha" aria-label="Fecha del feriado" />
        <input
          type="time"
          name="abre"
          aria-label="Hora especial de apertura"
          title="Vacío = cerrado todo el día"
        />
        <input
          type="time"
          name="cierra"
          aria-label="Hora especial de cierre"
          title="Vacío = cerrado todo el día"
        />
        <button type="submit" disabled={pendiente}>
          {pendiente ? '…' : 'Anotar el día'}
        </button>
      </form>
      <p className="tarjeta__pie">
        Sin horas, ese día cierra entero. Con horas, abre solo en esas — el
        horario normal de ese día no se aplica.
      </p>
      <Resultado estado={estado} />
    </>
  );
}

/** Quitar un feriado: ese día vuelve a regirse por el horario de la semana. */
export function BotonQuitarFeriado({
  locationId,
  fecha,
  weekly,
  feriados,
}: {
  locationId: string;
  fecha: string;
  weekly: Array<{ weekday: number; opensAt: string; closesAt: string }>;
  feriados: Array<{
    date: string;
    ranges: Array<{ opensAt: string; closesAt: string }>;
  }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    quitarFeriado,
    {},
  );
  return (
    <form action={accion} className="en-linea">
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="fecha" value={fecha} />
      <input type="hidden" name="semana" value={JSON.stringify(weekly)} />
      <input type="hidden" name="feriados" value={JSON.stringify(feriados)} />
      <button type="submit" className="discreto" disabled={pendiente}>
        {pendiente ? '…' : `Quitar ${fecha}`}
      </button>
      {estado.error ? (
        <span className="panel__error">{estado.error}</span>
      ) : null}
    </form>
  );
}

/** Una cocina dentro de un local. Sin ella no hay dónde producir. */
export function FormularioCocina({ locationId }: { locationId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    crearCocina,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="locationId" value={locationId} />
        <input
          name="name"
          placeholder="Cocina principal"
          aria-label={`Nombre de la cocina nueva en ${locationId}`}
        />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Añadir cocina'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

/**
 * Una estación dentro de la cocina.
 *
 * Es a las estaciones a las que salen los tickets: parrilla, frío, bebidas. Una
 * cocina sin ninguna no enseña nada en el KDS por mucho que entren pedidos.
 */
export function FormularioEstacion({ kitchenId }: { kitchenId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    crearEstacion,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="kitchenId" value={kitchenId} />
        <input
          name="name"
          className="corto"
          placeholder="Parrilla"
          aria-label={`Nombre de la estación nueva en ${kitchenId}`}
        />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Añadir estación'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

/**
 * Une la marca a una cocina (RN-ORG-01).
 *
 * Solo se ofrecen las cocinas a las que TODAVÍA no está unida: repetir el
 * enlace no rompe nada, pero un desplegable con opciones que no hacen nada
 * enseña a no fiarse de él.
 */
export function FormularioMarcaCocina({
  brandId,
  cocinas,
}: {
  brandId: string;
  cocinas: Array<{ id: string; name: string; local: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoNegocio, FormData>(
    unirMarcaACocina,
    {},
  );
  if (cocinas.length === 0) return null;
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="brandId" value={brandId} />
        <select
          name="kitchenId"
          defaultValue={cocinas[0]?.id}
          aria-label={`Cocina donde se produce ${brandId}`}
        >
          {cocinas.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {c.local}
            </option>
          ))}
        </select>
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Producir aquí'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}
