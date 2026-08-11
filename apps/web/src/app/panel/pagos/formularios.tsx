'use client';

import { useActionState } from 'react';
import { conectarPasarela, type EstadoPasarela } from './acciones';

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
