'use client';

import { useActionState, useState } from 'react';
import {
  crearRepartidor,
  cambiarEstadoRepartidor,
  crearEnvio,
  asignar,
  liquidar,
  enlaceDeSeguimiento,
  recoger,
  entregar,
  fallar,
  reintentar,
  devolver,
  type EstadoReparto,
} from './acciones';
import { MOTIVOS_FRECUENTES, MOTIVO_MAXIMO } from './motivo';

/** Los formularios de la mesa de despacho (spec 09). */

function Resultado({ estado }: { estado: EstadoReparto }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}

export function FormularioRepartidor({
  locales,
}: {
  locales: Array<{ id: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoReparto, FormData>(
    crearRepartidor,
    {},
  );
  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="rep-nombre">Nombre</label>
        <input id="rep-nombre" name="fullName" placeholder="Luis Ramos" />
      </div>
      <div className="campo">
        <label htmlFor="rep-local">Local</label>
        <select id="rep-local" name="locationId" defaultValue={locales[0]?.id}>
          {locales.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      <div className="campo">
        <label htmlFor="rep-tel">Teléfono</label>
        <input id="rep-tel" name="phone" className="corto" />
      </div>
      <div className="campo">
        <label htmlFor="rep-vehiculo">Vehículo</label>
        <select id="rep-vehiculo" name="vehicle" defaultValue="moto">
          <option value="moto">Moto</option>
          <option value="bici">Bicicleta</option>
          <option value="auto">Auto</option>
          <option value="pie">A pie</option>
        </select>
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Dando de alta…' : 'Dar de alta'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function BotonEstadoRepartidor({
  courierId,
  status,
}: {
  courierId: string;
  status: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoReparto, FormData>(
    cambiarEstadoRepartidor,
    {},
  );
  // Disponible ↔ fuera de turno. `busy` lo pone el sistema al asignar: ponerlo
  // a mano solo serviría para mentirle al ranking de asignación.
  const siguiente = status === 'off' ? 'available' : 'off';
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="courierId" value={courierId} />
        <input type="hidden" name="status" value={siguiente} />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente
            ? '…'
            : siguiente === 'off'
              ? 'Fin de turno'
              : 'Entra a turno'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

export function FormularioEnvio({
  orderId,
  totalSugerido,
}: {
  orderId: string;
  totalSugerido: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoReparto, FormData>(
    crearEnvio,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="orderId" value={orderId} />
        <input
          name="codAmount"
          className="corto"
          inputMode="decimal"
          placeholder="Contra entrega"
          defaultValue={estado.valores?.['codAmount'] ?? totalSugerido}
          aria-label={`Importe contra entrega de ${orderId}`}
        />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Crear envío'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

export function FormularioAsignacion({
  shipmentId,
  sugerencias,
}: {
  shipmentId: string;
  sugerencias: Array<{
    courierId: string;
    name: string;
    reason: string;
    activeShipments: number;
  }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoReparto, FormData>(
    asignar,
    {},
  );

  if (sugerencias.length === 0) {
    return (
      <p className="tarjeta__pie">
        Nadie disponible en este local. Da de alta un repartidor o haz que entre
        a turno.
      </p>
    );
  }

  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="shipmentId" value={shipmentId} />
        {/* El desplegable enseña el MOTIVO de cada uno, no solo el orden: en
            F5 quien decide es una persona, y una recomendación sin explicación
            no se sigue, se ignora. */}
        <select
          name="courierId"
          defaultValue={sugerencias[0]?.courierId}
          aria-label={`Repartidor para ${shipmentId}`}
        >
          {sugerencias.map((s) => (
            <option key={s.courierId} value={s.courierId}>
              {s.name} — {s.reason}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pendiente}>
          {pendiente ? '…' : 'Asignar'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

/**
 * Lo que le pasa al envío mientras está en la calle (RN-DLV-03).
 *
 * Un solo bloque por tarjeta y no cinco botones sueltos: en `assigned` lo único
 * que puede pasar es que lo recoja o que falle antes de salir; en `picked_up`,
 * que entregue o que falle. Ofrecer transiciones imposibles no da flexibilidad,
 * da errores del servidor a quien está despachando con prisa.
 */
export function AccionesDelEnvio({
  shipmentId,
  estado,
  contraEntrega,
}: {
  shipmentId: string;
  estado: string;
  /** Importe ya formateado, o `null` si el pedido viene pagado. */
  contraEntrega: string | null;
}) {
  return (
    <div className="acciones-envio">
      {estado === 'assigned' ? (
        <BotonSimple
          accion={recoger}
          shipmentId={shipmentId}
          rotulo="Ya lo recogió"
          rotuloEnCurso="Marcando…"
        />
      ) : null}
      {estado === 'picked_up' ? (
        <FormularioEntrega
          shipmentId={shipmentId}
          contraEntrega={contraEntrega}
        />
      ) : null}
      <FormularioFallo shipmentId={shipmentId} />
    </div>
  );
}

/**
 * Entregar. La casilla del cobro solo aparece si hay algo que cobrar.
 *
 * Viene marcada porque lo normal es que el repartidor traiga el dinero, pero es
 * una casilla y no un automatismo: quien despacha tiene que poder decir que no
 * lo trae, y esa diferencia se paga en el arqueo del turno.
 */
export function FormularioEntrega({
  shipmentId,
  contraEntrega,
}: {
  shipmentId: string;
  contraEntrega: string | null;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoReparto, FormData>(
    entregar,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="shipmentId" value={shipmentId} />
        <input
          type="hidden"
          name="hayContraEntrega"
          value={contraEntrega === null ? '0' : '1'}
        />
        {contraEntrega !== null ? (
          <label className="casilla" htmlFor={`cobrado-${shipmentId}`}>
            <input
              id={`cobrado-${shipmentId}`}
              type="checkbox"
              name="cobrado"
              defaultChecked
            />
            Trae los S/ {contraEntrega}
          </label>
        ) : null}
        <button type="submit" disabled={pendiente}>
          {pendiente ? 'Marcando…' : 'Entregado'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

/**
 * «No se pudo entregar».
 *
 * Se abre al pulsar en vez de ocupar sitio en cada tarjeta: lo habitual es que
 * la entrega salga bien, y un campo de texto en veinte tarjetas convierte la
 * columna en un formulario. El motivo va con sugerencias porque quien despacha
 * escribe con una mano y el teléfono en la otra.
 */
export function FormularioFallo({ shipmentId }: { shipmentId: string }) {
  const [abierto, setAbierto] = useState(false);
  const [estado, accion, pendiente] = useActionState<EstadoReparto, FormData>(
    fallar,
    {},
  );

  if (!abierto) {
    return (
      <button
        type="button"
        className="discreto"
        onClick={() => {
          setAbierto(true);
        }}
      >
        No se pudo entregar
      </button>
    );
  }

  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="shipmentId" value={shipmentId} />
        <input
          name="motivo"
          list="motivos-de-fallo"
          maxLength={MOTIVO_MAXIMO}
          defaultValue={estado.valores?.['motivo'] ?? ''}
          placeholder="Qué pasó"
          aria-label={`Motivo del fallo de ${shipmentId}`}
        />
        <button type="submit" disabled={pendiente}>
          {pendiente ? '…' : 'Anotar el fallo'}
        </button>
        <button
          type="button"
          className="discreto"
          onClick={() => {
            setAbierto(false);
          }}
        >
          Cancelar
        </button>
      </form>
      <datalist id="motivos-de-fallo">
        {MOTIVOS_FRECUENTES.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <Resultado estado={estado} />
    </>
  );
}

/**
 * Qué se hace con un envío ya fallido: otro intento o de vuelta al local.
 *
 * Es la «acción correctiva a un clic» que pide specs/ux/05 para la columna de
 * problemas. Hasta ahora la pantalla los enseñaba y decía, por escrito, que
 * había que resolverlos por API.
 */
export function AccionesDeFallo({ shipmentId }: { shipmentId: string }) {
  return (
    <div className="acciones-envio">
      <BotonSimple
        accion={reintentar}
        shipmentId={shipmentId}
        rotulo="Reintentar"
        rotuloEnCurso="…"
      />
      <BotonSimple
        accion={devolver}
        shipmentId={shipmentId}
        rotulo="Devolver al local"
        rotuloEnCurso="…"
        discreto
      />
    </div>
  );
}

/** Un botón que solo manda el id del envío. Cuatro acciones son iguales. */
function BotonSimple({
  accion,
  shipmentId,
  rotulo,
  rotuloEnCurso,
  discreto,
}: {
  accion: (prev: EstadoReparto, form: FormData) => Promise<EstadoReparto>;
  shipmentId: string;
  rotulo: string;
  rotuloEnCurso: string;
  discreto?: boolean;
}) {
  const [estado, enviar, pendiente] = useActionState<EstadoReparto, FormData>(
    accion,
    {},
  );
  return (
    <>
      <form action={enviar} className="en-linea">
        <input type="hidden" name="shipmentId" value={shipmentId} />
        <button
          type="submit"
          className={discreto ? 'discreto' : undefined}
          disabled={pendiente}
        >
          {pendiente ? rotuloEnCurso : rotulo}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

/**
 * «Enlace para el cliente».
 *
 * El resultado se enseña en un campo de solo lectura y no como texto suelto:
 * un enlace de 60 caracteres se selecciona mal con el dedo, y quien atiende el
 * teléfono lo necesita en el portapapeles en un toque, no en tres intentos.
 */
export function BotonSeguimiento({ shipmentId }: { shipmentId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoReparto, FormData>(
    enlaceDeSeguimiento,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="shipmentId" value={shipmentId} />
        {/* El origen sale del navegador porque el panel de cada cliente vive en
            SU dominio: componerlo en el servidor daría un enlace del dominio de
            otro. Sin JavaScript se queda vacío y la acción devuelve la ruta
            relativa, que sigue sirviendo. */}
        <input
          type="hidden"
          name="origen"
          value={typeof window === 'undefined' ? '' : window.location.origin}
        />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Enlace para el cliente'}
        </button>
      </form>
      {estado.ok ? (
        <input
          className="enlace-copiable"
          type="text"
          readOnly
          value={estado.ok}
          aria-label="Enlace de seguimiento"
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : null}
      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
    </>
  );
}

export function BotonLiquidar({
  courierId,
  sessionId,
  importe,
}: {
  courierId: string;
  sessionId: string;
  importe: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoReparto, FormData>(
    liquidar,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="courierId" value={courierId} />
        <input type="hidden" name="sessionId" value={sessionId} />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : `Liquidar S/ ${importe}`}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}
