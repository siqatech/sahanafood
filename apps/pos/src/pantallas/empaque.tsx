import { useCallback, useEffect, useState } from 'react';
import { aspectoDeCanal } from '@sahana/ui';
import { api, SinRed, type PedidoParaEmpacar } from '../lib/api';
import { ChecklistDeEmpaque } from './empaque-tarjeta';

/**
 * Empaque con verificación (ux/02 §Empaque, RN-KIT-03).
 *
 * Es el último filtro antes de que la comida salga por la puerta, y el paso que
 * más dinero ahorra de todo el KDS: **mandar el pedido incompleto cuesta el
 * pedido, el reparto y el cliente**. La regla —no se puede marcar «empacado»
 * con líneas sin verificar— la impone el servidor; esta pantalla la hace
 * usable.
 *
 * Va por PEDIDO y no por ticket: un pedido repartido entre parrilla y frío se
 * empaca una vez, mirando la bolsa completa. Empacar ticket a ticket sería la
 * forma más segura de mandar media bolsa.
 *
 * La marca se enseña grande porque la etiqueta se imprime con ella: en un local
 * con cuatro marcas, etiquetar con la equivocada es un error que ve el cliente.
 */

const REFRESCO_MS = 5_000;

export function Empaque({
  token,
  kitchenId,
}: {
  token: string;
  kitchenId: string;
}) {
  const [pedidos, setPedidos] = useState<PedidoParaEmpacar[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      setPedidos(await api.paraEmpacar(token, kitchenId));
      setAviso(null);
    } catch (error) {
      // Igual que la cola de cocina: NO se vacía la lista. Enseñar lo de hace
      // treinta segundos es mejor que enseñar nada.
      setAviso(
        error instanceof SinRed
          ? 'Sin conexión — mostrando lo último recibido.'
          : 'No se pudo actualizar la lista.',
      );
    }
  }, [token, kitchenId]);

  useEffect(() => {
    void cargar();
    const id = setInterval(() => {
      void cargar();
    }, REFRESCO_MS);
    return () => {
      clearInterval(id);
    };
  }, [cargar]);

  async function empacar(
    pedido: PedidoParaEmpacar,
    marcadas: string[],
  ): Promise<void> {
    try {
      const r = await api.empacar(token, pedido.orderId, marcadas);
      // Lo que se anuncia es la ETIQUETA, no «guardado»: quien empaca lo
      // siguiente que hace es pegarla, y con cuatro marcas en el local hay que
      // decirle cuál.
      setHecho(`#${pedido.orderNumber} — etiqueta de ${r.brandName}`);
      await cargar();
    } catch (error) {
      setAviso(
        error instanceof Error
          ? error.message
          : 'No se pudo empacar. Vuelve a intentarlo.',
      );
    }
  }

  return (
    <div className="kds">
      {aviso ? <div className="kds__aviso">{aviso}</div> : null}
      {hecho ? <div className="kds__confirmacion-fija">{hecho}</div> : null}
      <div className="empaque">
        {pedidos.length === 0 ? (
          <p className="kds__vacio">Nada esperando empaque.</p>
        ) : (
          pedidos.map((p) => (
            <article key={p.orderId} className="empaque__pedido">
              <header className="empaque__cabecera">
                <span className="comanda__numero">#{p.orderNumber}</span>
                <span className="empaque__marca">{p.brandName}</span>
                <span className={`canal ${aspectoDeCanal(p.channel).clase}`}>
                  {p.channel === ''
                    ? 'origen desconocido'
                    : aspectoDeCanal(p.channel).rotulo}
                </span>
              </header>
              <ChecklistDeEmpaque
                lineas={p.lines}
                onEmpacar={(marcadas) => {
                  void empacar(p, marcadas);
                }}
              />
            </article>
          ))
        )}
      </div>
    </div>
  );
}
