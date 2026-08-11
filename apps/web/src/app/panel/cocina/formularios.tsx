'use client';

import { useActionState } from 'react';
import { guardarCapacidad, type EstadoCapacidad } from './acciones';

/**
 * Los umbrales de una cocina (RN-KIT-04).
 *
 * Los dos números tienen un orden que no es evidente mirándolos: el primero
 * **alarga la promesa y se sigue vendiendo**; el segundo **cierra canales**. La
 * pantalla lo dice con esas palabras, porque un dueño que los ponga al revés
 * apaga sus propias ventas creyendo que las protege.
 */
export function FormularioCapacidad({
  kitchenId,
  actual,
  sugerido,
}: {
  kitchenId: string;
  actual: {
    maxConcurrentItems: number;
    extendMinutes: number;
    pauseThresholdItems: number | null;
    channelPauseOrder: string[];
    enabled: boolean;
  };
  sugerido: string[];
}) {
  const [estado, accion, pendiente] = useActionState<EstadoCapacidad, FormData>(
    guardarCapacidad,
    {},
  );

  // Lo que la persona escribió gana sobre lo guardado. Sin esto, un error en un
  // campo borra los otros cuatro: la acción de servidor vuelve a renderizar la
  // página y los campos no controlados regresan a su valor por defecto.
  const v = estado.valores;

  return (
    <form action={accion}>
      <input type="hidden" name="kitchenId" value={kitchenId} />

      <div className="campo">
        <label htmlFor={`max-${kitchenId}`}>
          Platos a la vez antes de alargar la promesa
        </label>
        <input
          id={`max-${kitchenId}`}
          name="maxConcurrentItems"
          className="corto"
          inputMode="numeric"
          defaultValue={v?.maxConcurrentItems ?? actual.maxConcurrentItems}
        />
        <span className="tarjeta__pie">
          Al pasar de aquí se sigue vendiendo: solo se promete más tarde. Un
          cliente al que le dicen 55 minutos no se va; uno al que le prometen 35
          y llega en 55, sí.
        </span>
      </div>

      <div className="campo">
        <label htmlFor={`ext-${kitchenId}`}>Cuántos minutos se alarga</label>
        <input
          id={`ext-${kitchenId}`}
          name="extendMinutes"
          className="corto"
          inputMode="numeric"
          defaultValue={v?.extendMinutes ?? actual.extendMinutes}
        />
      </div>

      <div className="campo">
        <label htmlFor={`pausa-${kitchenId}`}>
          Platos a la vez antes de CERRAR canales
        </label>
        <input
          id={`pausa-${kitchenId}`}
          name="pauseThresholdItems"
          className="corto"
          inputMode="numeric"
          defaultValue={
            v?.pauseThresholdItems ?? actual.pauseThresholdItems ?? ''
          }
        />
        <span className="tarjeta__pie">
          Tiene que ser mayor que el primero. Vacío = nunca se cierra nada solo,
          y entonces en hora punta la cocina acumula hasta que los tiempos se
          vuelven imposibles.
        </span>
      </div>

      <div className="campo">
        <label htmlFor={`orden-${kitchenId}`}>Orden en que se cierran</label>
        <input
          id={`orden-${kitchenId}`}
          name="channelPauseOrder"
          // Se precarga el sugerido cuando no hay ninguno guardado: la API
          // exige el orden en cuanto hay umbral de pausa, y dejar el campo
          // vacío convertiría el primer guardado en un error evitable.
          defaultValue={
            v?.channelPauseOrder ??
            (actual.channelPauseOrder.length > 0
              ? actual.channelPauseOrder.join(', ')
              : sugerido.join(', '))
          }
          placeholder="rappi, pedidosya, web"
        />
        <span className="tarjeta__pie">
          {sugerido.length > 0
            ? `Sugerido por comisión, de más cara a más barata: ${sugerido.join(', ')}. Es una sugerencia: el canal que más comisión cobra puede ser el que más clientes nuevos trae.`
            : 'Separados por comas. Se cierran de izquierda a derecha.'}
        </span>
      </div>

      <div className="campo">
        <label htmlFor={`on-${kitchenId}`}>
          <input
            id={`on-${kitchenId}`}
            name="enabled"
            type="checkbox"
            defaultChecked={v?.enabled ?? actual.enabled}
          />{' '}
          Aplicar automáticamente
        </label>
        <span className="tarjeta__pie">
          Desactivado, los umbrales se siguen midiendo y se ven en el histórico,
          pero no tocan nada. Sirve para mirar un mes antes de dejar que decida.
        </span>
      </div>

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Guardando…' : 'Guardar umbrales'}
      </button>
      {estado.error ? <p className="panel__error">{estado.error}</p> : null}
      {estado.ok ? <p className="tarjeta__pie">{estado.ok}</p> : null}
    </form>
  );
}
