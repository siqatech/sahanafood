'use client';

import { useActionState } from 'react';
import {
  crearRepartidor,
  cambiarEstadoRepartidor,
  crearEnvio,
  asignar,
  liquidar,
  type EstadoReparto,
} from './acciones';

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
          defaultValue={totalSugerido}
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
