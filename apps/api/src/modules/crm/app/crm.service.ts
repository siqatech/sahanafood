import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { Money } from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';

/**
 * Clientes: perfil unificado e historial (spec 14, la parte de F5).
 *
 * `specs/ux/03` lista «Clientes» en la estructura del panel y era el último
 * hueco de esa lista. Sin ella, la pregunta más común de un dueño —«¿este
 * señor cuánto nos compra?»— solo se contesta buscando su teléfono en el
 * listado de pedidos, una página cada vez.
 *
 * ## El cliente NO es una tabla
 *
 * No hay `crm_customers`, y es deliberado. El cliente **se deriva de sus
 * pedidos**, agrupados por teléfono. Una tabla propia obligaría a mantenerla
 * sincronizada en cada alta, cada corrección de teléfono y cada pedido de
 * marketplace que llega con el nombre escrito de otra forma — y el día que se
 * desincronice, el panel dirá que alguien compró tres veces cuando compró
 * cinco.
 *
 * Derivarlo cuesta una consulta agregada y **no puede mentir**.
 *
 * ## Unificado por TELÉFONO
 *
 * Es la única clave que el cliente escribe igual en los cinco canales. El
 * nombre no sirve: el mismo señor es «Juan Pérez» en la web, «juan» en WhatsApp
 * y «Cliente Rappi» en el marketplace. Cuando el mismo teléfono trae nombres
 * distintos se enseña **el más reciente**, que es el que él mismo escribió la
 * última vez.
 *
 * spec 14 pide además merge asistido por email cross-canal; eso queda para
 * cuando haya email, que hoy el checkout no lo pide.
 */

export interface ClienteResumen {
  phone: string;
  /** El más reciente de los nombres con que pidió. Puede faltar. */
  name: string | null;
  orders: number;
  /** Suma de lo entregado, como cadena decimal. Nunca coma flotante. */
  totalSpent: string;
  averageTicket: string;
  firstOrderAt: string;
  lastOrderAt: string;
  /** Por dónde ha pedido, para saber a quién pertenece la relación. */
  channels: string[];
  /** true si se anonimizó a solicitud (RN-CRM-02). */
  anonymized: boolean;
  /** true si pidió la baja de mensajes (RN-CRM-01). */
  optedOut: boolean;
}

export interface PedidoDeCliente {
  id: string;
  orderNumber: number;
  status: string;
  channel: string;
  createdAt: string;
  total: string;
}

export interface FichaDeCliente extends ClienteResumen {
  historial: PedidoDeCliente[];
}

/** Lo que se escribe en el teléfono al anonimizar. */
const TELEFONO_ANONIMO = 'anonimizado';

@Injectable()
export class CrmService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Los clientes, del que más gastó al que menos.
   *
   * Por gasto y no por fecha: la pregunta que trae a alguien a esta pantalla
   * casi nunca es «quién pidió hace poco» —para eso está el listado de
   * pedidos— sino «quiénes son los que sostienen el negocio».
   */
  async listar(
    tenantId: string,
    filtros: { search?: string | undefined; limit?: number | undefined } = {},
  ): Promise<ClienteResumen[]> {
    const limite = Math.min(Math.max(filtros.limit ?? 100, 1), 500);
    const busqueda = filtros.search?.trim() ?? '';

    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<FilaDeCliente>(
        `SELECT o.customer_phone                                  AS phone,
                (ARRAY_AGG(o.customer_name ORDER BY o.created_at DESC)
                   FILTER (WHERE o.customer_name IS NOT NULL))[1] AS name,
                count(*)::int                                     AS orders,
                -- Solo lo ENTREGADO cuenta como gasto: un pedido cancelado no
                -- es dinero que este cliente dejó, y sumarlo inflaría al que
                -- más cancela.
                COALESCE(sum(o.total) FILTER (WHERE o.status = 'delivered'), 0)::text AS total_spent,
                count(*) FILTER (WHERE o.status = 'delivered')::int AS delivered,
                min(o.created_at)                                 AS first_order_at,
                max(o.created_at)                                 AS last_order_at,
                ARRAY_AGG(DISTINCT o.channel)                     AS channels,
                bool_or(c.opted_out)                              AS opted_out
           FROM ord_orders o
           LEFT JOIN wa_contacts c ON c.phone = o.customer_phone
          WHERE o.customer_phone IS NOT NULL
            AND ($1 = '' OR o.customer_phone ILIKE '%' || $1 || '%'
                        OR o.customer_name  ILIKE '%' || $1 || '%')
          GROUP BY o.customer_phone
          ORDER BY 4 DESC, max(o.created_at) DESC
          LIMIT $2`,
        [busqueda, limite],
      );
      return rows.map((f) => this.aResumen(f));
    });
  }

  /** La ficha de uno, con su historial. */
  async ficha(tenantId: string, phone: string): Promise<FichaDeCliente> {
    const telefono = phone.trim();
    if (telefono === '') throw new ValidationError('Indica el teléfono.');

    const resumenes = await this.listar(tenantId, {
      search: telefono,
      limit: 500,
    });
    // Coincidencia EXACTA: la búsqueda es por «contiene» y con un teléfono
    // parcial devolvería varios. Enseñar la ficha del primero mezclaría dos
    // personas, que en una pantalla con su historial de compras es grave.
    const cliente = resumenes.find((c) => c.phone === telefono);
    if (!cliente) throw new NotFoundError('Ese cliente no existe.');

    const historial = await withTenant(
      this.pool,
      tenantId,
      async ({ client }) => {
        const { rows } = await client.query<{
          id: string;
          order_number: number;
          status: string;
          channel: string;
          created_at: Date;
          total: string;
        }>(
          `SELECT id, order_number, status, channel, created_at, total::text
             FROM ord_orders
            WHERE customer_phone = $1
            ORDER BY created_at DESC
            LIMIT 200`,
          [telefono],
        );
        return rows.map((r) => ({
          id: r.id,
          orderNumber: r.order_number,
          status: r.status,
          channel: r.channel,
          createdAt: r.created_at.toISOString(),
          total: r.total,
        }));
      },
    );

    return { ...cliente, historial };
  }

  /**
   * Anonimizar a solicitud (RN-CRM-02, Ley 29733).
   *
   * > se desvincula PII, queda el registro comercial.
   *
   * Es la regla entera: **los pedidos no se borran**. Un pedido es un registro
   * contable con cinco años de retención fiscal (docs/14), así que borrarlo
   * para atender una solicitud de datos personales cambiaría un problema legal
   * por otro peor. Lo que se va es lo que identifica: nombre, teléfono y
   * dirección de entrega. El importe, la fecha y el canal se quedan, y el
   * cuadre con SUNAT sigue cuadrando.
   *
   * **Irreversible por diseño.** No hay «deshacer»: si lo hubiera, el dato no
   * estaría anonimizado, estaría escondido — y eso no es lo que la ley pide.
   */
  async anonimizar(
    tenantId: string,
    phone: string,
    options: { motivo: string; actorId?: string | undefined },
  ): Promise<{ pedidos: number }> {
    const telefono = phone.trim();
    if (telefono === '') throw new ValidationError('Indica el teléfono.');
    if (telefono === TELEFONO_ANONIMO) {
      throw new ValidationError('Ese registro ya está anonimizado.');
    }
    const motivo = options.motivo.trim();
    if (motivo.length < 3) {
      throw new ValidationError(
        'Escribe por qué se anonimiza: es una solicitud del cliente y queda en el histórico.',
      );
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rowCount } = await ctx.client.query(
        `UPDATE ord_orders
            SET customer_name = NULL,
                customer_phone = $1,
                delivery_address = NULL,
                updated_at = now()
          WHERE customer_phone = $2`,
        [TELEFONO_ANONIMO, telefono],
      );
      if (!rowCount) throw new NotFoundError('Ese cliente no existe.');

      // El contacto de WhatsApp también: si se quedara, el teléfono seguiría
      // en la base y la anonimización sería mentira.
      await ctx.client.query('DELETE FROM wa_contacts WHERE phone = $1', [
        telefono,
      ]);

      // En el histórico NO se escribe el teléfono: sería dejar el dato personal
      // en la única tabla que no se puede borrar. Queda cuántos pedidos y por
      // qué, que es lo que hay que poder demostrar.
      await recordAudit(ctx, {
        actorType: options.actorId ? 'user' : 'system',
        ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
        action: 'crm.customer_anonymized',
        resourceType: 'customer',
        reason: motivo,
        data: { pedidos: rowCount },
      });

      return { pedidos: rowCount };
    });
  }

  private aResumen(f: FilaDeCliente): ClienteResumen {
    // El ticket promedio se calcula con `Money`, en enteros: es una división y
    // hacerla en coma flotante metería el error justo en la cifra que decide a
    // quién se le manda una promoción.
    const gastado = Money.parse(f.total_spent);
    const promedio =
      f.delivered === 0
        ? Money.zero('PEN')
        : Money.fromMinor(Math.round(gastado.minorUnits / f.delivered), 'PEN');

    return {
      phone: f.phone,
      name: f.name,
      orders: f.orders,
      totalSpent: gastado.toDecimalString(),
      averageTicket: promedio.toDecimalString(),
      firstOrderAt: f.first_order_at.toISOString(),
      lastOrderAt: f.last_order_at.toISOString(),
      channels: f.channels.filter(Boolean).sort(),
      anonymized: f.phone === TELEFONO_ANONIMO,
      optedOut: f.opted_out === true,
    };
  }
}

interface FilaDeCliente {
  phone: string;
  name: string | null;
  orders: number;
  total_spent: string;
  delivered: number;
  first_order_at: Date;
  last_order_at: Date;
  channels: string[];
  opted_out: boolean | null;
}
