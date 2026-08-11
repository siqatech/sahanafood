'use client';

import { useActionState } from 'react';
import { registrarConsentimiento, type EstadoMensajeria } from './acciones';

/** Alta y baja de consentimiento (RN-T10). */
export function FormularioConsentimiento() {
  const [estado, accion, pendiente] = useActionState<
    EstadoMensajeria,
    FormData
  >(registrarConsentimiento, {});
  const v = estado.valores;

  return (
    <form action={accion}>
      <div className="campo">
        <label htmlFor="ms-tel">Teléfono</label>
        <input
          id="ms-tel"
          name="phone"
          className="corto"
          defaultValue={v?.['phone'] ?? ''}
          placeholder="+51987654321"
        />
      </div>

      <div className="campo">
        <label htmlFor="ms-accion">Qué se registra</label>
        <select id="ms-accion" name="action" defaultValue="granted">
          <option value="granted">Dio su consentimiento</option>
          <option value="revoked">Pidió la baja</option>
        </select>
      </div>

      <div className="campo">
        <label htmlFor="ms-origen">De dónde salió</label>
        <input
          id="ms-origen"
          name="source"
          className="corto"
          defaultValue={v?.['source'] ?? ''}
          placeholder="mostrador"
        />
      </div>

      <div className="campo">
        <label htmlFor="ms-texto">Texto exacto</label>
        <textarea
          id="ms-texto"
          name="consentText"
          rows={3}
          defaultValue={v?.['consentText'] ?? ''}
          placeholder="Acepto recibir avisos de mi pedido por WhatsApp."
        />
        <span className="tarjeta__pie">
          Es lo que se enseña cuando alguien reclama: la frase que leyó, no un
          «sí» que no demuestra nada.
        </span>
      </div>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Registrando…' : 'Registrar'}
      </button>
      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
      {estado.ok ? <p className="tarjeta__pie">{estado.ok}</p> : null}
    </form>
  );
}
