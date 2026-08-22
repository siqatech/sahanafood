'use client';

import { useEffect, useState } from 'react';
import {
  camposDeDeshacer,
  corren,
  quePintar,
  SEGUNDOS_PARA_DESHACER,
} from './aviso-reglas';

export { SEGUNDOS_PARA_DESHACER } from './aviso-reglas';

/**
 * El aviso con deshacer (docs/25: «toast con deshacer (8 s) donde sea
 * reversible», y «Deshacer en catálogos y precios — los dedos gordos en tablets
 * existen»).
 *
 * ## Por qué ocho segundos y no una confirmación previa
 *
 * Cambiar un precio es una acción que se hace veinte veces seguidas cuando sube
 * el pollo. Pedir «¿seguro?» en cada una entrena a pulsar «sí» sin leer, y a la
 * vigésima el diálogo ya no protege de nada. Dejar hacer y ofrecer deshacer
 * mueve el coste al caso raro —el error— en vez de cobrárselo a los diecinueve
 * aciertos.
 *
 * ## Tres decisiones que no son evidentes
 *
 *  · **El error NO se va solo.** Solo el «hecho» tiene cuenta atrás. Un aviso
 *    de error que desaparece a los ocho segundos es un error que el operador no
 *    llegó a leer, y entonces cree que guardó cuando no guardó. Se cierra a
 *    mano.
 *  · **Deshacer es una acción de servidor de verdad**, no un `setState`. Lo que
 *    se revierte ya está escrito en la base y probablemente ya lo vio un
 *    cliente en la tienda; deshacerlo solo en la pantalla dejaría al dueño
 *    creyendo que el precio viejo volvió.
 *  · **Lo deshecho no se puede volver a deshacer.** El formulario de deshacer
 *    manda `esDeshacer=1` y la acción de servidor omite entonces el `deshacer`
 *    de su respuesta. Sin eso quedaría un par de avisos que se revierten
 *    mutuamente para siempre y nadie sabría en qué estado quedó el precio.
 *
 * La cuenta atrás se ve. Un plazo invisible es un plazo que se pierde.
 *
 * Las decisiones —qué se pinta, si corre el reloj— viven en `aviso-reglas.ts`,
 * que sí tiene pruebas: es lo único de aquí que puede estar mal sin verse.
 */

/** Lo que hace falta para revertir: los campos que se reenvían tal cual. */
export interface Deshacer {
  /** Qué se revierte, en palabras: «volver a S/ 32.00». */
  rotulo: string;
  campos: Record<string, string>;
}

export function AvisoConDeshacer({
  ok,
  error,
  deshacer,
  accionDeshacer,
}: {
  ok?: string | undefined;
  error?: string | undefined;
  deshacer?: Deshacer | undefined;
  /** La acción de servidor que revierte. Recibe los `campos` como FormData. */
  accionDeshacer?: ((form: FormData) => void) | undefined;
}) {
  const [restan, setRestan] = useState(SEGUNDOS_PARA_DESHACER);
  const [cerrado, setCerrado] = useState(false);

  // La clave del efecto es el propio mensaje: dos guardados seguidos del mismo
  // campo tienen que reiniciar la cuenta, no continuar la del anterior.
  const clave = `${ok ?? ''}|${error ?? ''}`;

  useEffect(() => {
    setCerrado(false);
    setRestan(SEGUNDOS_PARA_DESHACER);
    // Solo lo correcto se va solo; el error espera a que lo lean.
    if (!corren({ ok, error })) return;
    const reloj = setInterval(() => {
      setRestan((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(reloj);
  }, [clave, ok, error]);

  const pintar = quePintar({ ok, error, restan, cerrado });
  if (pintar === 'nada') return null;

  if (pintar === 'error') {
    return (
      <p className="aviso aviso--error" role="alert">
        <span className="aviso__texto">{error}</span>
        <button
          type="button"
          className="aviso__cerrar"
          onClick={() => setCerrado(true)}
          aria-label="Cerrar el aviso"
        >
          ✕
        </button>
      </p>
    );
  }

  return (
    // `role="status"` y no `alert`: es una confirmación, y un lector de pantalla
    // no debe interrumpir a media frase para decir que algo salió bien.
    <div className="aviso aviso--ok" role="status">
      <span className="aviso__texto">{ok}</span>
      {deshacer && accionDeshacer ? (
        <form action={accionDeshacer} className="aviso__deshacer">
          {Object.entries(camposDeDeshacer(deshacer.campos)).map(
            ([nombre, valor]) => (
              <input key={nombre} type="hidden" name={nombre} value={valor} />
            ),
          )}
          <button type="submit" className="aviso__boton">
            Deshacer
            <span className="aviso__cuenta" aria-hidden="true">
              {restan}
            </span>
          </button>
          <span className="visualmente-oculto">
            {deshacer.rotulo}. Quedan {restan} segundos.
          </span>
        </form>
      ) : null}
    </div>
  );
}
