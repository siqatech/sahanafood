'use client';

import { useActionState } from 'react';
import { setAddress, confirmOrder, type ActionState } from '../actions';
import { TEXTO_CONSENTIMIENTO } from '../../lib/consent';

/**
 * Dirección y datos del cliente.
 *
 * Las coordenadas van en campos ocultos porque el selector de mapa llega en
 * T5.15; hasta entonces se rellenan con el centro de la zona de reparto para
 * que el flujo sea probable de punta a punta. Lo que NO cambia con el mapa es
 * quién decide: la cobertura la resuelve el servidor con el polígono, no el
 * navegador.
 */
export function CheckoutForm({
  conDireccion,
  total,
}: {
  conDireccion: boolean;
  total: string;
}) {
  const [estadoDir, accionDir, dirPendiente] = useActionState<
    ActionState,
    FormData
  >(setAddress, {});
  const [estado, accion, pendiente] = useActionState<ActionState, FormData>(
    confirmOrder,
    {},
  );

  return (
    <>
      <form action={accionDir}>
        <h2>¿Dónde lo entregamos?</h2>
        <div className="campo">
          <label htmlFor="address">Dirección</label>
          <input
            id="address"
            name="address"
            type="text"
            required
            minLength={5}
            autoComplete="street-address"
            placeholder="Av. Larco 456, Miraflores"
          />
        </div>
        {/* Provisional hasta el selector de mapa de T5.15. */}
        <input type="hidden" name="lat" value="-12.125" />
        <input type="hidden" name="lng" value="-77.02" />
        {estadoDir.error ? (
          <p className="aviso" role="alert">
            {estadoDir.error}
          </p>
        ) : null}
        <button type="submit" className="secundario" disabled={dirPendiente}>
          {conDireccion ? 'Cambiar dirección' : 'Usar esta dirección'}
        </button>
      </form>

      <form action={accion}>
        <h2>Tus datos</h2>
        <div className="campo">
          <label htmlFor="name">Nombre</label>
          <input
            id="name"
            name="name"
            type="text"
            required
            minLength={2}
            autoComplete="name"
          />
        </div>
        <div className="campo">
          <label htmlFor="phone">Teléfono</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            required
            minLength={6}
            autoComplete="tel"
            placeholder="+51 987 654 321"
          />
        </div>
        <div className="campo">
          <label htmlFor="notes">Referencia o indicaciones (opcional)</label>
          <textarea id="notes" name="notes" rows={2} maxLength={280} />
        </div>

        {/*
          Casilla PROPIA, sin marcar y separada de cualquier «acepto los
          términos» (RN-T10, Ley 29733). El texto que se enseña es el mismo que
          se guarda con el consentimiento: un booleano no acredita qué aceptó
          nadie.
        */}
        <div className="consentimiento">
          <input id="marketingConsent" name="marketingConsent" type="checkbox" />
          <label htmlFor="marketingConsent">{TEXTO_CONSENTIMIENTO}</label>
        </div>

        {estado.error ? (
          <p className="aviso" role="alert">
            {estado.error}
          </p>
        ) : null}

        <button type="submit" disabled={pendiente}>
          {pendiente ? 'Confirmando…' : `Confirmar pedido · ${total}`}
        </button>
      </form>
    </>
  );
}
