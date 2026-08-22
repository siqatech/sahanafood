import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';

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
}

@Injectable()
export class OnboardingService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async checklist(tenantId: string): Promise<ChecklistDeSalida> {
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
    };
  }
}
