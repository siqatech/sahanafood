'use client';

import { COLUMNAS } from './liquidacion';

import { useActionState } from 'react';
import {
  conectarPasarela,
  ponerTarifa,
  importarLiquidacion,
  type EstadoPasarela,
  type EstadoPagos,
} from './acciones';

/**
 * Conectar la pasarela.
 *
 * El secreto de firma y la clave de API se escriben una vez y no se vuelven a
 * enseñar: se guardan cifradas y no hay motivo para volver a leerlas. Si se
 * pierden, se rota la clave en la pasarela y se conecta de nuevo.
 */
export function FormularioPasarela({ dominio }: { dominio: string }) {
  const [estado, accion, pendiente] = useActionState<EstadoPasarela, FormData>(
    conectarPasarela,
    {},
  );

  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="pg-proveedor">Pasarela</label>
        <select id="pg-proveedor" name="provider" defaultValue="culqi_sandbox">
          <option value="culqi_sandbox">Culqi (pruebas)</option>
          <option value="mercadopago_sandbox">MercadoPago (pruebas)</option>
        </select>
        <span className="tarjeta__pie">
          Las de pruebas no mueven dinero: sirven para comprobar el flujo
          completo antes de contratar.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="pg-secreto">Secreto de firma del aviso</label>
        <input
          id="pg-secreto"
          name="webhookSecret"
          type="password"
          autoComplete="off"
        />
        <span className="tarjeta__pie">
          Te lo da la pasarela. Es lo que nos permite comprobar que un aviso de
          «pago confirmado» viene de ella y no de cualquiera.
        </span>
      </div>

      <div className="campo">
        <label htmlFor="pg-clave">Clave de API (opcional)</label>
        <input
          id="pg-clave"
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder="sk_test_…"
        />
      </div>

      <fieldset className="campo">
        <legend>Qué medios aceptas</legend>
        {[
          ['card', 'Tarjeta'],
          ['yape', 'Yape'],
          ['plin', 'Plin'],
          ['apple_pay', 'Apple Pay'],
          ['google_pay', 'Google Pay'],
        ].map(([valor, nombre]) => (
          <div className="consentimiento" key={valor}>
            <input
              id={`pg-${valor}`}
              name={`medio-${valor}`}
              type="checkbox"
              defaultChecked={valor === 'card'}
            />
            <label htmlFor={`pg-${valor}`}>{nombre}</label>
          </div>
        ))}
      </fieldset>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Conectando…' : 'Conectar'}
      </button>

      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
      {estado.ok ? (
        <>
          <p className="tarjeta__pie">{estado.ok}</p>
          {estado.callbackPath ? (
            <>
              <p className="tarjeta__pie">
                <strong>Pega esta dirección en el panel de tu pasarela</strong>,
                donde pida la URL de notificaciones. Sin ella los pagos se
                confirman en su lado y aquí los pedidos se quedan pendientes
                para siempre:
              </p>
              <pre className="codigo">
                https://{dominio}
                {estado.callbackPath}
              </pre>
            </>
          ) : null}
        </>
      ) : null}
    </form>
  );
}

/**
 * La comisión pactada con la pasarela, por canal (ADR-0013).
 *
 * Se escribe en porcentaje —«3.5»— porque es como se pacta y como viene en el
 * contrato; se guarda en puntos básicos enteros, que es como se multiplica sin
 * coma flotante. Sin esto, la conciliación sabe si el bruto cuadra pero no si
 * la comisión es la acordada.
 */
export function FormularioTarifa({ canales }: { canales: string[] }) {
  const [estado, accion, pendiente] = useActionState<EstadoPagos, FormData>(
    ponerTarifa,
    {},
  );
  return (
    <>
      <form action={accion} className="en-linea">
        <select name="channel" defaultValue={canales[0]} aria-label="Canal">
          {canales.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          name="porcentaje"
          className="corto"
          inputMode="decimal"
          placeholder="3.5"
          aria-label="Comisión en porcentaje"
          defaultValue={estado.valores?.['porcentaje'] ?? ''}
        />
        <span className="tarjeta__pie">% +</span>
        <input
          name="fijo"
          className="corto"
          inputMode="decimal"
          placeholder="0.50"
          aria-label="Comisión fija por cobro"
          defaultValue={estado.valores?.['fijo'] ?? ''}
        />
        <button type="submit" className="discreto" disabled={pendiente}>
          {pendiente ? '…' : 'Guardar comisión'}
        </button>
      </form>
      <ResultadoPagos estado={estado} />
    </>
  );
}

/**
 * Sube el archivo del corte y lo concilia en el acto.
 *
 * Las dos cosas juntas a propósito: importar sin conciliar deja el archivo
 * guardado y la pregunta sin responder, y la pregunta —«¿me pagaron lo que
 * dicen?»— es la única razón por la que alguien sube esto.
 *
 * El archivo se **pega** en vez de subirse: un `<input type="file">` obliga a
 * leerlo en el navegador y a mandarlo por otra vía, y el archivo de una
 * pasarela son treinta líneas que se copian de una hoja. Cuando haya que
 * aceptar el formato nativo de cada proveedor, eso será un adaptador y no un
 * campo más.
 */
export function FormularioLiquidacion({
  proveedores,
}: {
  proveedores: string[];
}) {
  const [estado, accion, pendiente] = useActionState<EstadoPagos, FormData>(
    importarLiquidacion,
    {},
  );
  return (
    <form action={accion} className="ficha">
      <h3 style={{ marginTop: 0 }}>Conciliar un corte</h3>
      <div className="campo">
        <label htmlFor="liq-proveedor">Pasarela</label>
        <select
          id="liq-proveedor"
          name="provider"
          defaultValue={proveedores[0]}
        >
          {proveedores.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="campo">
        <label htmlFor="liq-ref">Referencia del corte</label>
        <input
          id="liq-ref"
          name="externalRef"
          placeholder="LIQ-2026-08-15"
          defaultValue={estado.valores?.['externalRef'] ?? ''}
        />
        <p className="tarjeta__pie">
          La que trae el archivo de la pasarela. Es lo que evita importar el
          mismo corte dos veces.
        </p>
      </div>
      <div className="campo en-linea">
        <label htmlFor="liq-desde">Del</label>
        <input
          id="liq-desde"
          type="date"
          name="periodStart"
          defaultValue={estado.valores?.['periodStart'] ?? ''}
        />
        <label htmlFor="liq-hasta">al</label>
        <input
          id="liq-hasta"
          type="date"
          name="periodEnd"
          defaultValue={estado.valores?.['periodEnd'] ?? ''}
        />
      </div>
      <div className="campo">
        <label htmlFor="liq-archivo">Cobros del corte</label>
        <textarea
          id="liq-archivo"
          name="archivo"
          rows={8}
          placeholder={`${COLUMNAS.join(';')}\nABC-1;32.50;1.14;31.36`}
          defaultValue={estado.valores?.['archivo'] ?? ''}
        />
        <p className="tarjeta__pie">
          Pega el detalle del archivo de la pasarela, con la cabecera{' '}
          <code>{COLUMNAS.join(';')}</code>. Los totales se calculan de las
          líneas: teclearlos aparte solo daría la oportunidad de equivocarse.
        </p>
      </div>
      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Conciliando…' : 'Importar y conciliar'}
      </button>
      <ResultadoPagos estado={estado} />
    </form>
  );
}

function ResultadoPagos({ estado }: { estado: EstadoPagos }) {
  if (estado.error) return <p className="panel__error">{estado.error}</p>;
  if (estado.ok) return <p className="tarjeta__pie">{estado.ok}</p>;
  return null;
}
