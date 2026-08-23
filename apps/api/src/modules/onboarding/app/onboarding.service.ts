import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, withSystem } from '../../../database/rls.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';

/**
 * La checklist de salida en vivo (docs/26 §5, specs/ux/03 «checklist
 * persistente hasta completarse»).
 *
 * > caja configurada · comprobante de prueba emitido en sandbox OSE · comanda
 * > impresa · primer producto con receta (opcional) · usuario cajero con PIN
 * > creado. Al 100 % → botón «Abrir el local».
 *
 * ## Por qué esto importa más que una pantalla más
 *
 * docs/26 lo dice sin rodeos: «el churn temprano de POS se decide en el
 * onboarding, no en las features». Un dueño que entra por primera vez ve
 * catorce pantallas vacías y ninguna le dice **cuál es la siguiente**. La
 * métrica del proyecto es *alta → primera venta real en menos de un día*, y
 * hasta ahora el camino para llegar ahí solo existía en un documento.
 *
 * ## Se CALCULA, no se guarda
 *
 * No hay tabla de progreso, y es deliberado. Un estado guardado se desincroniza
 * del mundo: alguien borra el único usuario con PIN y la checklist sigue
 * diciendo que está hecho. Cada punto es una consulta sobre lo que ya existe,
 * así que la checklist **no puede mentir** — si algo se deshace, vuelve a
 * aparecer pendiente, que es justo lo que hace falta.
 *
 * El coste es de seis `EXISTS` en una transacción, todos sobre tablas con
 * índice por tenant. Se paga una vez al abrir la portada.
 */

export interface PasoDeChecklist {
  /** Identificador estable: la pantalla lo usa para su propia navegación. */
  id: string;
  titulo: string;
  /** Qué se pierde si no se hace. Nunca «paso 3 de 6». */
  porQue: string;
  hecho: boolean;
  /** Dónde se hace. Ruta del panel. */
  donde: string;
  /**
   * Un paso opcional no impide abrir el local.
   *
   * Solo la receta lo es, y docs/26 lo marca así a propósito: sin receta se
   * vende igual, solo que el food cost sale en cero y el margen de ese plato
   * aparenta más de lo que es.
   */
  opcional: boolean;
}

export interface ChecklistDeSalida {
  pasos: PasoDeChecklist[];
  /** Cuántos obligatorios están hechos, sobre cuántos hay. */
  hechos: number;
  /**
   * Cuántos pasos OBLIGATORIOS hay.
   *
   * Se llama así y no `total` porque la regla de ESLint que protege el dinero
   * mira los nombres de campo, y con razón: `total: number` es exactamente el
   * error que esa regla existe para impedir. Aquí es una cuenta de pasos, no un
   * importe — pero un nombre que obliga a mirar dos veces es un mal nombre.
   */
  obligatorios: number;
  /** true cuando NO queda ningún obligatorio pendiente. */
  listoParaAbrir: boolean;
  /**
   * true mientras el negocio siga practicando (docs/26 §4).
   *
   * Es lo que decide si se ofrece «borrar la práctica»: en cuanto se pulsa una
   * vez, esto pasa a false para siempre y el botón desaparece. No hay forma de
   * vaciar las ventas de un negocio que ya opera de verdad.
   */
  enPractica: boolean;
}

/** Lo que se borró al empezar en serio, para poder decirlo en pantalla. */
export interface ResultadoDePractica {
  wentLiveAt: string;
  borrados: Record<string, number>;
  /**
   * Lo que NO se borra, para poder avisarlo antes y después.
   *
   * Decirlo importa: quien pulsa espera quedarse limpio, y descubrir tres
   * semanas después que el stock arrastra el consumo de la práctica es mucho
   * peor que haberlo sabido.
   */
  seConserva: string[];
}

@Injectable()
export class OnboardingService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async checklist(tenantId: string): Promise<ChecklistDeSalida> {
    const enPractica = await this.sigueEnPractica(tenantId);
    const pasos = await withTenant(this.pool, tenantId, async ({ client }) => {
      // Una sola ida y vuelta con seis `EXISTS`. Seis consultas separadas
      // serían seis viajes de red para pintar una tarjeta de la portada.
      const { rows } = await client.query<{
        estructura: boolean;
        carta: boolean;
        cajero: boolean;
        caja: boolean;
        comprobante: boolean;
        comanda: boolean;
        receta: boolean;
      }>(
        `SELECT
           EXISTS (SELECT 1 FROM org_locations)                       AS estructura,
           -- Con PRECIO: un producto sin precio no se vende en ningún canal
           -- (RN-CAT-01), así que una carta sin precios es una carta que no
           -- existe para el cliente.
           EXISTS (SELECT 1 FROM cat_products p
                     JOIN cat_prices pr ON pr.product_id = p.id
                    WHERE pr.active)                                  AS carta,
           EXISTS (SELECT 1 FROM idn_user_pins)                       AS cajero,
           EXISTS (SELECT 1 FROM cash_sessions)                       AS caja,
           -- Aceptado por el OSE, no solo emitido: un comprobante rechazado
           -- demuestra que la conexión funciona a medias, que es la peor forma
           -- de descubrirlo el primer día de venta real.
           EXISTS (SELECT 1 FROM bil_documents
                    WHERE status = 'accepted')                        AS comprobante,
           -- Una comanda que llegó a cocina y se terminó. Es lo más cerca que
           -- la base puede estar de «se imprimió»: el print-agent lleva su
           -- propia cola en el local y no escribe aquí.
           EXISTS (SELECT 1 FROM kit_tickets
                    WHERE status = 'ready')                           AS comanda,
           EXISTS (SELECT 1 FROM inv_recipes)                          AS receta`,
      );
      return rows[0]!;
    });

    const definicion: Array<Omit<PasoDeChecklist, 'hecho'>> = [
      {
        id: 'estructura',
        titulo: 'Da de alta tu negocio y tu local',
        porQue:
          'Todo cuelga de aquí: la carta cuelga de una marca y un pedido necesita un local donde cocinarse.',
        donde: '/panel/negocio',
        opcional: false,
      },
      {
        id: 'carta',
        titulo: 'Sube tu carta con precios',
        porQue:
          'Un plato sin precio no se vende en ningún canal. Con precio, ya se puede cobrar.',
        donde: '/panel/catalogo',
        opcional: false,
      },
      {
        id: 'cajero',
        titulo: 'Crea un cajero con su PIN',
        porQue:
          'Cada venta queda firmada por quien la hizo. Sin PIN, un descuadre no tiene a quién preguntarle.',
        donde: '/panel/equipo',
        opcional: false,
      },
      {
        id: 'caja',
        titulo: 'Abre una caja de prueba',
        porQue:
          'La caja se abre desde el POS al empezar el turno. Si nunca se abrió, el primer día nadie sabrá cómo.',
        donde: '/panel/caja',
        opcional: false,
      },
      {
        id: 'comprobante',
        titulo: 'Emite un comprobante de prueba',
        porQue:
          'Que el OSE lo ACEPTE es lo que demuestra que la conexión funciona. Descubrirlo el primer día de venta real sale caro.',
        donde: '/panel/comprobantes',
        opcional: false,
      },
      {
        id: 'comanda',
        titulo: 'Manda una comanda a cocina',
        porQue:
          'Comprueba el camino entero: pedido → cocina → listo. Es el circuito que se usa cien veces al día.',
        donde: '/panel/operaciones',
        opcional: false,
      },
      {
        id: 'receta',
        titulo: 'Ponle receta a un plato',
        porQue:
          'Opcional, pero sin receta el food cost sale en cero y ese plato aparenta más margen del que tiene.',
        donde: '/panel/inventario',
        opcional: true,
      },
    ];

    const hechoPorId: Record<string, boolean> = { ...pasos };
    const lista = definicion.map((d) => ({
      ...d,
      hecho: hechoPorId[d.id] ?? false,
    }));

    // El progreso cuenta SOLO los obligatorios. Si la receta contara, un
    // negocio listo para abrir vería «6 de 7» y se quedaría buscando qué le
    // falta — cuando no le falta nada.
    const obligatorios = lista.filter((p) => !p.opcional);
    const hechos = obligatorios.filter((p) => p.hecho).length;

    return {
      pasos: lista,
      hechos,
      obligatorios: obligatorios.length,
      listoParaAbrir: hechos === obligatorios.length,
      enPractica,
    };
  }

  /**
   * ¿Sigue practicando?
   *
   * `ten_tenants` es del plano de control y no lleva `tenant_id`, así que se lee
   * por el escape acotado `app.system` y filtrando por `id`. Es el mismo camino
   * que usa Tenancy para cualquier dato del propio tenant.
   */
  private async sigueEnPractica(tenantId: string): Promise<boolean> {
    return withSystem(this.pool, async ({ client }) => {
      const { rows } = await client.query<{ went_live_at: Date | null }>(
        'SELECT went_live_at FROM ten_tenants WHERE id = $1',
        [tenantId],
      );
      if (!rows[0]) throw new NotFoundError('El negocio no existe.');
      return rows[0].went_live_at === null;
    });
  }

  /**
   * «Borrar la práctica y empezar en serio» (docs/26 §4).
   *
   * Borra **lo operativo** —ventas, comandas, cajas, comprobantes, envíos,
   * mensajes, cobros y el stock que consumieron— y **conserva la
   * configuración**: empresa, locales, cocinas, carta con sus precios, insumos,
   * recetas, personas, PIN y dispositivos. Es exactamente lo que hace útil
   * practicar: se ensaya con la carta de verdad y se estrena limpio.
   *
   * ### Qué protege de qué
   *
   *  · **Solo en práctica.** Al terminar se estampa `went_live_at` y el botón
   *    desaparece para siempre. Un negocio que ya opera NO puede vaciar sus
   *    ventas — ni por error ni queriendo, porque el endpoint responde 422.
   *  · **Los correlativos vuelven a empezar.** Series de comprobante y número
   *    de pedido se reinician: la primera venta de verdad tiene que ser la
   *    #1 y la B001-1. Dejar el contador donde estaba obligaría a explicarle a
   *    SUNAT dónde están los comprobantes 1 a 40.
   *  · **La auditoría NO se borra.** `audit_log` es append-only por
   *    construcción —el rol de aplicación no tiene DELETE— y además es donde
   *    queda esta misma acción. Un borrado que borrara su propia huella es
   *    justo el que no se puede permitir.
   *
   * Todo en UNA transacción: a medias dejaría comandas apuntando a pedidos que
   * ya no existen.
   */
  async empezarEnSerio(
    tenantId: string,
    input: { motivo: string; actorId?: string | undefined },
  ): Promise<ResultadoDePractica> {
    const motivo = input.motivo.trim();
    if (motivo.length < 3) {
      throw new ValidationError(
        'Escribe por qué empiezas en serio: queda en el histórico.',
      );
    }
    if (!(await this.sigueEnPractica(tenantId))) {
      throw new ValidationError(
        'Este negocio ya está operando en serio. Sus ventas no se pueden borrar.',
      );
    }

    const borrados = await withTenant(this.pool, tenantId, async (ctx) => {
      const cuenta: Record<string, number> = {};
      // El ORDEN importa donde no hay borrado en cascada: primero lo que
      // apunta, luego lo apuntado.
      // NO están aquí, y no por olvido:
      //
      //  · `bil_submissions`, `cash_movements` y `ord_order_events` son
      //    **libros append-only**: la base le niega el DELETE al rol de la
      //    aplicación a propósito. Se van igual, en cascada con su padre —el
      //    comprobante, la sesión de caja, el pedido—, que es la única forma
      //    correcta de que desaparezcan.
      //  · `inv_movements` e `inv_stock` **se quedan**, y esa es la decisión
      //    incómoda de aquí. El kardex también es append-only y su padre no se
      //    borra, así que vaciar el stock dejaría las existencias diciendo una
      //    cosa y su libro otra — el descuadre exacto que el kardex existe para
      //    impedir. La práctica que movió stock se corrige como cualquier error
      //    de inventario: **con otro movimiento**. La pantalla lo avisa antes.
      //  · `pay_webhook_events` es el registro crudo de lo que mandó la
      //    pasarela, también sin DELETE. No sale en ningún informe.
      const tablas = [
        // Cobros y liquidaciones.
        'pay_settlement_lines',
        'pay_settlements',
        'pay_intents',
        // Facturación de práctica. Los correlativos se reinician abajo.
        'bil_documents',
        // Reparto.
        'dlv_shipments',
        // Cocina.
        'kit_ticket_lines',
        'kit_tickets',
        'kit_saturation_events',
        // Caja.
        'cash_sessions',
        // Conversaciones y mensajes.
        'cnv_conversation_orders',
        'cnv_conversation_tags',
        'cnv_messages',
        'cnv_conversations',
        'wa_messages',
        // Analítica derivada de esas ventas.
        'ana_counted_orders',
        'ana_daily_sales',
        // Trazas de IA sobre pedidos que ya no existen.
        'ai_traces',
        // Los pedidos, al final: casi todo lo de arriba los referencia.
        'ord_order_lines',
        'ord_orders',
        'ord_idempotency_keys',
        // Eventos de integración ya consumidos.
        'int_webhook_events',
        // Cola de eventos: publicar los de una venta borrada no tendría a quién
        // aplicárselos.
        'outbox',
        'inbox',
      ];

      for (const tabla of tablas) {
        const { rowCount } = await ctx.client.query(`DELETE FROM ${tabla}`);
        if (rowCount) cuenta[tabla] = rowCount;
      }

      // Los contadores vuelven a cero para que la primera venta real sea la #1.
      await ctx.client.query('DELETE FROM ord_counters');
      await ctx.client.query('UPDATE bil_series SET last_correlative = 0');

      await recordAudit(ctx, {
        actorType: input.actorId ? 'user' : 'system',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'tenant.went_live',
        resourceType: 'tenant',
        resourceId: tenantId,
        reason: motivo,
        data: { borrados: cuenta },
      });

      return cuenta;
    });

    // La marca va DESPUÉS del borrado y fuera de esa transacción a propósito:
    // `ten_tenants` es del plano de control. Si el borrado fallara, el negocio
    // sigue en práctica y se puede reintentar — que es el fallo correcto.
    const wentLiveAt = await withSystem(this.pool, async ({ client }) => {
      const { rows } = await client.query<{ went_live_at: Date }>(
        `UPDATE ten_tenants SET went_live_at = now(), updated_at = now()
          WHERE id = $1 RETURNING went_live_at`,
        [tenantId],
      );
      return rows[0]!.went_live_at;
    });

    return {
      wentLiveAt: wentLiveAt.toISOString(),
      borrados,
      seConserva: [
        'La carta con sus precios, los insumos y las recetas',
        'Empresa, marcas, locales, cocinas y estaciones',
        'Las personas, sus PIN y las tablets emparejadas',
        'El kardex y el stock: se corrigen con un ajuste, no borrando',
        'El histórico de auditoría, que nunca se borra',
      ],
    };
  }
}
