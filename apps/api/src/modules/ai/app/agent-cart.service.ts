import { Injectable, Logger } from '@nestjs/common';
import { StorefrontService } from '../../storefront/index.js';
import type { ToolResult } from './agent-tools.service.js';

/**
 * El carrito del agente (spec 19 §3, `order.start_cart`).
 *
 * Vive APARTE de `AgentToolsService` a propósito. Aquella clase es de **solo
 * lectura**, y esa restricción es la mitad del diseño del agente: el LLM
 * consulta, nunca escribe. Esta es la única excepción, así que está en su
 * propio archivo para que se vea, en vez de escondida entre las consultas.
 *
 * Y la excepción es pequeña de verdad: **abre un carrito vacío y devuelve su
 * enlace**. No añade productos, no fija precios, no confirma nada. Lo que el
 * cliente acabe comprando lo decide él en la tienda, con el checkout
 * estructurado — porque una compra confirmada por texto libre es una compra
 * que nadie puede demostrar (ADR-0011 §2). Abrir un carrito de más no cuesta
 * nada: caduca solo y no cobra.
 */
@Injectable()
export class AgentCartService {
  private readonly logger = new Logger(AgentCartService.name);

  constructor(private readonly storefront: StorefrontService) {}

  /**
   * Abre un carrito para la marca y lo devuelve como resultado de herramienta.
   *
   * `null` si la marca no tiene tienda con dominio verificado: mandar un token
   * sin URL sería mandar un enlace roto, y un enlace roto en medio de una
   * venta es peor que no mandar ninguno.
   */
  async startCart(
    tenantId: string,
    brandId: string,
  ): Promise<ToolResult | null> {
    try {
      const carrito = await this.storefront.createCartForBrand(
        tenantId,
        brandId,
      );
      if (!carrito.url) return null;

      return {
        tool: 'order.start_cart',
        // Redacción DELIBERADAMENTE seca. La primera versión decía «Carrito
        // ABIERTO para este cliente» y el validador de T5.24 bloqueaba la
        // respuesta entera: «abierto» es una afirmación de horario, y este
        // resultado no respalda ningún dato duro. El validador tenía razón —
        // el fallo era el texto—. Todo lo que una herramienta mete en el
        // contexto puede acabar citado por el modelo, así que una herramienta
        // que no respalda hechos no puede escribir palabras que parezcan uno.
        summary: `Enlace de carrito para este cliente: ${carrito.url}`,
        // Ni precios ni stock: este resultado no respalda ningún dato duro, así
        // que el validador de T5.24 sigue bloqueando cualquier importe que el
        // modelo escriba sin haber consultado el catálogo.
        kinds: [],
        values: [],
      };
    } catch (error) {
      // Que la tienda falle NO puede dejar sin respuesta a quien pregunta: se
      // sigue sin carrito, y el cliente recibe la información igual.
      this.logger.warn(
        `No se pudo abrir carrito para la marca ${brandId}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
