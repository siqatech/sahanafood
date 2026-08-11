'use client';

import { useActionState } from 'react';
import {
  conectarCanal,
  cambiarEstadoDeConexion,
  registrarDominio,
  verificarDominio,
  type EstadoCanales,
} from './acciones';

/** Alta de conectores y dominios (specs 13 y 11). */

function Resultado({ estado }: { estado: EstadoCanales }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  // El token de verificación viaja en este mensaje y hay que poder copiarlo:
  // se pinta en bloque monoespaciado, no en una línea de pie de tarjeta.
  if (estado.ok) return <p className="codigo">{estado.ok}</p>;
  return null;
}

export function FormularioConexion({
  marcas,
  locales,
}: {
  marcas: Array<{ id: string; name: string }>;
  locales: Array<{ id: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCanales, FormData>(
    conectarCanal,
    {},
  );
  const v = estado.valores;
  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="cx-conector">Conector</label>
        {/* Solo el simulador: los conectores reales llegan en F7 y ofrecerlos
            aquí sería prometer una integración que no existe. */}
        <select
          id="cx-conector"
          name="provider"
          defaultValue={v?.['provider'] ?? 'simulador'}
        >
          <option value="simulador">Simulador de marketplace</option>
        </select>
        <span className="tarjeta__pie">
          Los conectores reales (Rappi, PedidosYa) llegan en F7. El simulador
          habla el mismo protocolo, así que lo que se pruebe aquí vale.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="cx-canal">Canal</label>
        <input
          id="cx-canal"
          name="channel"
          className="corto"
          defaultValue={v?.['channel'] ?? ''}
          placeholder="rappi"
        />
      </div>

      <div className="campo">
        <label htmlFor="cx-marca">Marca</label>
        <select id="cx-marca" name="brandId" defaultValue={marcas[0]?.id}>
          {marcas.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      <div className="campo">
        <label htmlFor="cx-local">Local</label>
        <select id="cx-local" name="locationId" defaultValue={locales[0]?.id}>
          {locales.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <div className="campo">
        <label htmlFor="cx-secreto">Secreto de firma</label>
        <input
          id="cx-secreto"
          name="signingSecret"
          type="password"
          autoComplete="off"
        />
        <span className="tarjeta__pie">
          Lo da el canal. Es lo que separa un pedido real de uno inventado por
          quien descubra la URL, y no se vuelve a enseñar: ni al dueño.
        </span>
      </div>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Conectando…' : 'Conectar'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function BotonEstadoDeConexion({
  connectionId,
  status,
}: {
  connectionId: string;
  status: string;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCanales, FormData>(
    cambiarEstadoDeConexion,
    {},
  );
  const siguiente = status === 'active' ? 'paused' : 'active';
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="connectionId" value={connectionId} />
        <input type="hidden" name="status" value={siguiente} />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : siguiente === 'active' ? 'Reactivar' : 'Pausar'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}

export function FormularioDominio({
  marcas,
}: {
  marcas: Array<{ id: string; name: string }>;
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCanales, FormData>(
    registrarDominio,
    {},
  );
  const v = estado.valores;
  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="dm-marca">Marca</label>
        <select id="dm-marca" name="brandId" defaultValue={marcas[0]?.id}>
          {marcas.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <span className="tarjeta__pie">
          Un dominio sirve la carta de UNA marca: es lo que decide qué ve quien
          entra por ahí.
        </span>
      </div>
      <div className="campo">
        <label htmlFor="dm-host">Dominio</label>
        <input
          id="dm-host"
          name="host"
          defaultValue={v?.['host'] ?? ''}
          placeholder="pedidos.mipolleria.pe"
        />
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Registrando…' : 'Registrar'}
      </button>
      <Resultado estado={estado} />
    </form>
  );
}

export function BotonVerificar({ domainId }: { domainId: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoCanales, FormData>(
    verificarDominio,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <input type="hidden" name="domainId" value={domainId} />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Verificar'}
        </button>
      </form>
      <Resultado estado={estado} />
    </>
  );
}
