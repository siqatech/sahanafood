import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '../../../database/rls.js';
import { circuitAllows } from '../domain/circuit-breaker.js';
import type { ChannelConnector } from '../domain/channel-connector.js';
import { IngestionService } from './ingestion.service.js';

/**
 * Propagación SALIENTE hacia los canales (spec 13, RN-INT-05).
 *
 * `ChannelConnector` siempre tuvo dos mitades. La de entrada —firma, `identify`,
 * `parseOrder`— se cableó en F4 con la ingesta. La de salida —`pushMenu`,
 * `setAvailability`, `updateOrderStatus`, `cancelAck`— estaba implementada en el
 * simulador, probada contra él… y **no la llamaba nadie**. El efecto en
 * producción es exactamente lo que RN-INT-05 advierte: se pausa un producto
 * agotado en Sahana, el marketplace no se entera y **sigue vendiéndolo**. Cada
 * pedido que entra por ahí es una cancelación, una penalización del canal y un
 * cliente que esperó comida que no existía.
 *
 * Esta clase es el llamador que faltaba. Se dispara por EVENTOS y no desde los
 * servicios de catálogo o pedidos: así una caída de Rappi no puede impedir
 * pausar un producto ni aceptar un pedido (RN-INT-03, bulkhead).
 *
 * **Sobre las consultas directas.** Lee `cat_catalog_versions` y `ord_orders`
 * con SQL sobre el `ctx` del evento en vez de llamar a Catalog u Ordering. No
 * es un atajo: los servicios de esos módulos abren su propia transacción con
 * `withTenant`, y hacerlo desde dentro del handler significa tomar una segunda
 * conexión del pool mientras la primera sigue abierta. Con concurrencia eso
 * agota el pool y se bloquea a sí mismo. La alternativa —transacción del evento
 * o llamada al módulo— no existe: hay que elegir, y la corrección del pool pesa
 * más que la pureza de la frontera. Es la misma decisión que ya toma el
 * consumidor de caja al leer `ord_orders`.
 */

/** Lo que se hizo con un evento, para poder afirmarlo en las pruebas. */
export interface ResultadoDePropagacion {
  /** Conexiones a las que SÍ se llamó. */
  enviadas: number;
  /** Conexiones saltadas por tener el cortacircuitos abierto. */
  omitidas: number;
}

interface FilaDeConexion {
  id: string;
  provider: string;
  channel: string;
  consecutive_failures: number;
  circuit_opened_at: Date | null;
}

const NADA: ResultadoDePropagacion = { enviadas: 0, omitidas: 0 };

@Injectable()
export class ChannelSyncService {
  private readonly logger = new Logger(ChannelSyncService.name);

  /**
   * El registro de conectores vive en `IngestionService` desde F4 y es el mismo
   * para entrada y salida: un conector se registra UNA vez y sirve para las dos
   * direcciones. Duplicar el registro aquí abriría la puerta a que un
   * proveedor recibiera pedidos y no confirmaciones.
   */
  constructor(private readonly ingestion: IngestionService) {}

  // ------------------------------------------------------------ Disponibilidad

  /**
   * Pausa o reactiva un producto en los canales indicados (RN-INT-05).
   *
   * Traduce el `productId` interno al SKU de cada canal con `int_catalog_map`.
   * Un producto sin mapa en una conexión no se envía: el canal no lo conoce, y
   * mandarle un SKU que no existe es un error por cada pausa.
   */
  async propagarDisponibilidad(
    ctx: TenantContext,
    input: { productId: string; channels: string[]; available: boolean },
    now = new Date(),
  ): Promise<ResultadoDePropagacion> {
    if (input.channels.length === 0) return NADA;

    const { rows } = await ctx.client.query<
      FilaDeConexion & { external_sku: string }
    >(
      `SELECT c.id, c.provider, c.channel, c.consecutive_failures,
              c.circuit_opened_at, m.external_sku
         FROM int_catalog_map m
         JOIN int_connections c ON c.id = m.connection_id
        WHERE m.product_id = $1
          AND c.status = 'active'
          AND c.channel = ANY($2::text[])`,
      [input.productId, input.channels],
    );

    return this.paraCada(rows, now, async (connector, fila) => {
      await connector.setAvailability([
        { externalSku: fila.external_sku, available: input.available },
      ]);
    });
  }

  // -------------------------------------------------------------------- Menú

  /**
   * Publica el menú recién versionado en las conexiones de esa marca y canal.
   *
   * Envía la instantánea TAL CUAL se guardó al publicar, no una resolución
   * fresca del catálogo: el canal debe recibir exactamente la versión que se
   * aprobó, aunque alguien haya tocado un precio entre la publicación y este
   * envío.
   */
  async propagarMenu(
    ctx: TenantContext,
    input: { brandId: string; channel: string; version: number },
    now = new Date(),
  ): Promise<ResultadoDePropagacion> {
    const { rows: versiones } = await ctx.client.query<{ snapshot: unknown }>(
      `SELECT snapshot FROM cat_catalog_versions
        WHERE brand_id = $1 AND channel = $2 AND version = $3`,
      [input.brandId, input.channel, input.version],
    );
    const snapshot = versiones[0]?.snapshot;
    if (snapshot === undefined) {
      // La versión no está: o el evento es de otro tenant (RLS ya lo filtró) o
      // se borró. No se reintenta —no va a aparecer— pero se deja constancia.
      this.logger.warn(
        `Versión ${input.version} de ${input.brandId}/${input.channel} no encontrada: no se propaga menú.`,
      );
      return NADA;
    }

    const { rows } = await ctx.client.query<FilaDeConexion>(
      `SELECT id, provider, channel, consecutive_failures, circuit_opened_at
         FROM int_connections
        WHERE brand_id = $1 AND channel = $2 AND status = 'active'`,
      [input.brandId, input.channel],
    );

    return this.paraCada(rows, now, async (connector) => {
      await connector.pushMenu(String(input.version), snapshot);
    });
  }

  // ---------------------------------------------------------- Estado del pedido

  /**
   * Informa al canal de origen del nuevo estado del pedido.
   *
   * Solo aplica a pedidos que ENTRARON por un canal externo: los de la tienda
   * propia y los del POS no tienen `external_ref` y no hay a quién avisar. Un
   * `updateOrderStatus` con referencia vacía sería una llamada garantizada a
   * fallar por cada venta del mostrador.
   */
  async propagarEstado(
    ctx: TenantContext,
    input: { orderId: string; status: string },
    now = new Date(),
  ): Promise<ResultadoDePropagacion> {
    const { rows: pedidos } = await ctx.client.query<{
      external_ref: string | null;
      channel: string;
      brand_id: string;
    }>('SELECT external_ref, channel, brand_id FROM ord_orders WHERE id = $1', [
      input.orderId,
    ]);
    const pedido = pedidos[0];
    if (!pedido?.external_ref) return NADA;
    const externalRef = pedido.external_ref;

    const { rows } = await ctx.client.query<FilaDeConexion>(
      `SELECT id, provider, channel, consecutive_failures, circuit_opened_at
         FROM int_connections
        WHERE brand_id = $1 AND channel = $2 AND status = 'active'`,
      [pedido.brand_id, pedido.channel],
    );

    return this.paraCada(rows, now, async (connector) => {
      // Una cancelación se acusa además con `cancelAck`: varios canales exigen
      // esa confirmación explícita para cerrar el pedido de su lado, y sin ella
      // el pedido queda «cancelándose» para siempre en su panel.
      await connector.updateOrderStatus(externalRef, input.status);
      if (input.status === 'cancelled' || input.status === 'rejected') {
        await connector.cancelAck(externalRef);
      }
    });
  }

  // ------------------------------------------------------------------ Interno

  /**
   * Ejecuta la llamada saliente sobre cada conexión, respetando el
   * cortacircuitos.
   *
   * **El fallo SE PROPAGA a propósito.** El handler comparte transacción con la
   * marca de `inbox`: al lanzar, la marca se deshace y BullMQ reintenta con
   * backoff (5 intentos), que es literalmente lo que pide RN-INT-05. Tragarse
   * el error —como hace mensajería, donde un aviso perdido es un aviso perdido—
   * aquí dejaría el canal vendiendo un producto agotado sin reintento alguno.
   *
   * Por el mismo motivo el contador del cortacircuitos NO se toca desde aquí:
   * cualquier escritura que hiciéramos antes de lanzar se iría con el rollback.
   * El circuito lo abre la ingesta, que sí escribe en su propia transacción, y
   * esta ruta lo LEE para no machacar a un proveedor que ya se sabe caído.
   */
  private async paraCada<F extends FilaDeConexion>(
    conexiones: F[],
    now: Date,
    accion: (connector: ChannelConnector, fila: F) => Promise<void>,
  ): Promise<ResultadoDePropagacion> {
    let enviadas = 0;
    let omitidas = 0;

    for (const fila of conexiones) {
      const abierto = !circuitAllows(
        {
          consecutiveFailures: fila.consecutive_failures,
          circuitOpenedAt: fila.circuit_opened_at,
        },
        now,
      );
      if (abierto) {
        omitidas++;
        this.logger.warn(
          `Cortacircuitos abierto en ${fila.provider}/${fila.channel}: no se propaga (la divergencia se ve en el estado de la conexión).`,
        );
        continue;
      }
      await accion(this.ingestion.connectorFor(fila.provider), fila);
      enviadas++;
    }

    return { enviadas, omitidas };
  }
}
