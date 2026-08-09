import { Injectable } from '@nestjs/common';
import { Money } from '@sahana/domain';
import type { TenantContext } from '../../../database/rls.js';
import type { DomainEventHandler } from '../../kitchen/index.js';

/**
 * Las ventas del mostrador entran en el arqueo (spec 06, RN-POS-02).
 *
 * ### El agujero que esto tapa
 *
 * `cash_movements` solo se escribía desde el endpoint manual y desde el cobro
 * contra entrega. **Ninguna venta del POS llegaba a la caja.** Un turno con
 * S/ 2 000 en efectivo cerraba con un «esperado» igual al fondo inicial, y el
 * arqueo mostraba un sobrante exactamente del tamaño de lo vendido. Todos los
 * días, en todos los locales.
 *
 * No se vio antes porque cada pieza estaba bien por separado: la caja sabía
 * sumar movimientos, el POS sabía cobrar y el pedido se guardaba correcto. Lo
 * que faltaba era el cable — el mismo patrón que ya apareció con el relay del
 * outbox, con el consumidor de IA y con la autenticación de dispositivos.
 *
 * ### Por qué por evento y no llamando a Cash desde Ordering
 *
 * Porque Ordering no puede depender de Cash (ADR-0001: la API pública de un
 * módulo es su `index.ts`, y un pedido no sabe nada de gavetas) y sobre todo
 * porque **una caja cerrada no puede tumbar una venta**. Si Ordering llamara a
 * Cash dentro de su transacción, un turno cerrado por descuido haría fallar el
 * `submit` y el cajero no podría cobrar. Por el outbox, la venta entra siempre
 * y el movimiento se registra si hay dónde.
 *
 * Comparte transacción con la marca del `inbox`: o el movimiento entra y queda
 * marcado, o no pasa ninguna de las dos cosas. Reprocesar un evento no puede
 * sumar la misma venta dos veces al arqueo.
 */
export const CASH_CONSUMER = 'cash';

@Injectable()
export class CashEventHandlers {
  handlers(): Record<string, DomainEventHandler> {
    return {
      'order.accepted': async (ctx, event) => {
        await this.registrarVenta(ctx, event.aggregateId);
      },
    };
  }

  private async registrarVenta(
    ctx: TenantContext,
    orderId: string,
  ): Promise<void> {
    const { rows } = await ctx.client.query<{
      location_id: string;
      total: string;
      payment_method: string | null;
    }>(
      'SELECT location_id, total, payment_method FROM ord_orders WHERE id = $1',
      [orderId],
    );
    const pedido = rows[0];
    // Sin medio de pago no hubo cobro en el mostrador: la tienda web cobra por
    // pasarela y un marketplace liquida aparte. No es un error, es que ese
    // pedido no toca esta caja.
    if (!pedido?.payment_method) return;

    const { rows: sesiones } = await ctx.client.query<{ id: string }>(
      `SELECT id FROM cash_sessions
        WHERE location_id = $1 AND status = 'open'
        ORDER BY opened_at DESC
        LIMIT 1`,
      [pedido.location_id],
    );
    const sesion = sesiones[0];
    // Sin turno abierto no hay dónde apuntarlo. **No se falla**: la venta ya
    // está hecha y el cliente se fue. Se pierde el apunte de caja, que es malo,
    // pero tumbar el consumidor dejaría además sin procesar los eventos que
    // vienen detrás — cocina, inventario, analítica.
    if (!sesion) return;

    const importe = Money.parse(pedido.total);
    if (importe.minorUnits <= 0) return;

    // Idempotente por (sesión, pedido) aunque el `inbox` ya lo garantice: un
    // reproceso manual no pasa por el inbox, y duplicar aquí sería inventar
    // dinero en el arqueo de un turno.
    await ctx.client.query(
      `INSERT INTO cash_movements
         (tenant_id, session_id, kind, method, amount, order_id, reason)
       SELECT $1, $2, 'sale', $3, $4, $5, 'Venta del mostrador'
        WHERE NOT EXISTS (
          SELECT 1 FROM cash_movements
           WHERE session_id = $2 AND order_id = $5 AND kind = 'sale'
        )`,
      [
        ctx.tenantId,
        sesion.id,
        pedido.payment_method,
        importe.toDecimalString(),
        orderId,
      ],
    );
  }
}
