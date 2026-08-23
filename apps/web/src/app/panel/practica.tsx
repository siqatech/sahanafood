'use client';

import { useActionState } from 'react';
import { ConfirmacionDestructiva } from './confirmar';
import { empezarEnSerio, type EstadoPractica } from './practica-acciones';

/**
 * «Borrar la práctica y empezar en serio» (docs/26 §4).
 *
 * Un dueño recién dado de alta necesita equivocarse: cobrar mal, anular, cerrar
 * la caja con descuadre, mandar una comanda que no existe. Si esas pruebas se
 * quedan mezcladas con las ventas de verdad, el primer informe de rentabilidad
 * miente y el primer cuadre con SUNAT no cuadra. Y si por miedo a ensuciar NO
 * prueba, se estrena el sábado a las ocho de la noche.
 *
 * Es **la acción más destructiva del panel** —borra las ventas del negocio
 * entero— así que va con la confirmación de docs/25: motivo escrito y, sobre
 * todo, **consecuencias listadas**, que es lo que specs/ux/03 pide para las
 * acciones peligrosas. Se dice antes qué se va y qué se queda, en particular lo
 * que sorprende: el kardex de inventario NO se borra.
 */
export function ModoPractica() {
  const [estado, accion, pendiente] = useActionState<EstadoPractica, FormData>(
    empezarEnSerio,
    {},
  );

  if (estado.hecho) {
    return (
      <section className="practica practica--hecho">
        <h2 className="arranque__titulo">Ya estás operando en serio</h2>
        <p className="tarjeta__pie">
          Las ventas de práctica se borraron y los correlativos empiezan de
          nuevo: tu próxima venta será la #1.
        </p>
        {estado.seConserva ? (
          <ul className="practica__lista">
            {estado.seConserva.map((linea) => (
              <li key={linea}>{linea}</li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }

  return (
    <section className="practica">
      <h2 className="arranque__titulo">Estás en modo práctica</h2>
      <p className="tarjeta__pie">
        Prueba todo lo que quieras: cobra, anula, cierra caja con descuadre,
        manda comandas. Cuando estés listo, borra la práctica y empieza en serio
        — se van las ventas de prueba y se queda tu configuración.
      </p>

      {estado.error ? <p className="panel__error">{estado.error}</p> : null}

      <form action={accion} className="en-linea">
        <ConfirmacionDestructiva
          titulo="Borrar la práctica y empezar en serio"
          advertencia={
            'Se borran TODAS las ventas, comandas, cajas, comprobantes, envíos y ' +
            'mensajes de prueba, y los correlativos vuelven a empezar. No se ' +
            'puede deshacer. Se conservan la carta con sus precios, la estructura ' +
            'del negocio, las personas con su PIN, el kardex de inventario —que ' +
            'se corrige con un ajuste, no borrando— y el histórico de auditoría.'
          }
          rotuloBoton="Borrar la práctica y empezar en serio"
          rotuloConfirmar="Sí, empezar en serio"
          etiquetaMotivo="¿Por qué empiezas en serio?"
          pendiente={pendiente}
        />
      </form>
    </section>
  );
}
