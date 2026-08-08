import { Injectable } from '@nestjs/common';
import { Money, type FactKind } from '@sahana/domain';
import { CatalogService } from '../../catalog/index.js';
import { OrganizationService } from '../../organization/index.js';

/**
 * Herramientas tipadas del agente (spec 19 §3, T5.26).
 *
 * **Solo lectura**, y esa restricción es la mitad del diseño. El LLM nunca
 * escribe: consulta. La confirmación de un pedido y el cobro son estructurados
 * —carrito y checkout— porque una compra confirmada por texto libre es una
 * compra que nadie puede demostrar (ADR-0011 §2).
 *
 * Cada resultado declara **qué tipo de dato duro respalda** y **con qué
 * valores**. Eso es lo que el validador de T5.24 usa para decidir si la
 * respuesta sale: sin esta correspondencia, el validador solo podría comprobar
 * «se llamó a algo de precios», y el fallo más probable —consultar el precio
 * del pollo y citar el de la gaseosa— pasaría.
 */

export interface ToolResult {
  tool: string;
  /** Texto que se le pasa al modelo como contexto. */
  summary: string;
  /** Qué clases de dato duro respalda este resultado. */
  kinds: readonly FactKind[];
  /** Valores concretos, normalizados. Precios en céntimos de escala 4. */
  values: readonly string[];
}

/**
 * Palabras que disparan cada herramienta.
 *
 * Enrutado por léxico y no por el modelo, a propósito: decidir QUÉ consultar no
 * puede depender de que el modelo acierte, porque si no consulta el precio, el
 * validador bloquea la respuesta y el cliente se queda sin contestación. Es
 * barato, es determinista y falla hacia consultar de más.
 */
/**
 * Límite de palabra que entiende las tildes.
 *
 * `\b` de JavaScript NO sirve aquí: las vocales acentuadas no son caracteres de
 * palabra, así que `/\bmen[uú]\b/` **nunca** casa con «menú» —entre «ú» y el
 * signo de cierre no hay frontera porque ninguno de los dos es `\w`—. Con el
 * `\b` de toda la vida, «¿me pasas el menú?» y «¿hacen envío?» no disparaban
 * ninguna herramienta, y la respuesta salía sin catálogo ni cobertura detrás:
 * exactamente el caso que el validador acaba bloqueando y el cliente vive como
 * un bot que no contesta.
 *
 * La lookahead/lookbehind sobre `\p{L}\p{N}` sí trata «ú» como letra, y de paso
 * hace que el plural dispare («pollos», «combos») sin dejar de rechazar
 * «cartera» para «carta».
 */
const INI = '(?<![\\p{L}\\p{N}])';
const FIN = '(?![\\p{L}\\p{N}])';

function palabras(...alternativas: string[]): RegExp {
  return new RegExp(`${INI}(?:${alternativas.join('|')})${FIN}`, 'iu');
}

const DISPARADORES: ReadonlyArray<{ tool: string; re: RegExp }> = [
  {
    tool: 'catalog.search',
    re: palabras(
      'precio',
      'cuesta',
      'cu[aá]nto',
      'cartas?',
      'men[uú]s?',
      'tienen',
      'hay',
      'pollos?',
      'combos?',
      // `\p{L}*` y no `\w*`: con `\w*` la coincidencia paraba antes de la «ó»
      // de «promoción» y la letra siguiente hacía fallar el límite.
      'promo\\p{L}*',
    ),
  },
  {
    tool: 'org.coverage',
    re: palabras(
      'llegan',
      'llegas',
      'reparto',
      'reparten',
      'delivery',
      'env[ií]os?',
      'zonas?',
      'direcci[oó]n',
      'domicilio',
    ),
  },
  {
    tool: 'org.hours',
    re: palabras(
      'horarios?',
      'abren',
      'cierran',
      'abierto',
      'cerrado',
      'atienden',
      'hora',
    ),
  },
];

@Injectable()
export class AgentToolsService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly organization: OrganizationService,
  ) {}

  /** Ejecuta las herramientas que el mensaje pide. */
  async runFor(
    tenantId: string,
    input: { brandId: string; text: string },
  ): Promise<ToolResult[]> {
    const pedidas = DISPARADORES.filter((d) => d.re.test(input.text)).map(
      (d) => d.tool,
    );
    const resultados: ToolResult[] = [];

    for (const tool of new Set(pedidas)) {
      try {
        const r = await this.run(tenantId, tool, input);
        if (r) resultados.push(r);
      } catch {
        // Una herramienta que falla NO tumba la respuesta: se queda sin ese
        // respaldo, y entonces el validador bloqueará cualquier dato de ese
        // tipo. Falla hacia no afirmar, que es la dirección correcta.
      }
    }
    return resultados;
  }

  private async run(
    tenantId: string,
    tool: string,
    input: { brandId: string; text: string },
  ): Promise<ToolResult | null> {
    switch (tool) {
      case 'catalog.search':
        return this.catalogSearch(tenantId, input.brandId);
      case 'org.coverage':
        return this.coverage(tenantId, input.brandId);
      case 'org.hours':
        return this.hours(tenantId, input.brandId);
      default:
        return null;
    }
  }

  /**
   * Catálogo vigente de la marca, con precios REALES.
   *
   * Devuelve el catálogo del canal `whatsapp`: el mismo que cobraría un pedido
   * hecho por ahí. Devolver el de web daría precios que el pedido no aplica, y
   * el cliente vería un número y pagaría otro.
   */
  private async catalogSearch(
    tenantId: string,
    brandId: string,
  ): Promise<ToolResult> {
    const catalogo = await this.catalog.getResolvedCatalog(tenantId, {
      brandId,
      channel: 'whatsapp',
    });

    const productos = catalogo.products.slice(0, 8);
    const lineas = productos.map(
      (p) =>
        `${p.name}: S/ ${Money.fromMinor(p.price.minorUnits).toDecimalString()}`,
    );

    return {
      tool: 'catalog.search',
      summary:
        productos.length > 0
          ? `Carta vigente — ${lineas.join('; ')}.`
          : 'No hay productos disponibles ahora mismo.',
      kinds: ['price', 'stock'],
      // Los céntimos exactos: es contra esto que el validador compara el
      // importe que el modelo escribió.
      values: productos.map((p) => String(p.price.minorUnits)),
    };
  }

  private async coverage(
    tenantId: string,
    brandId: string,
  ): Promise<ToolResult> {
    const cocinas = await this.organization.kitchensForBrand(tenantId, brandId);
    return {
      tool: 'org.coverage',
      summary:
        cocinas.length > 0
          ? 'La marca reparte desde sus locales; la cobertura exacta depende de la dirección.'
          : 'Esta marca no tiene reparto activo.',
      kinds: ['coverage'],
      values: [],
    };
  }

  private async hours(tenantId: string, brandId: string): Promise<ToolResult> {
    const cocinas = await this.organization.kitchensForBrand(tenantId, brandId);
    const locationId = cocinas[0]?.locationId;
    if (!locationId) {
      return {
        tool: 'org.hours',
        summary: 'No hay horario configurado para esta marca.',
        kinds: ['hours'],
        values: [],
      };
    }
    const abierto = await this.organization.isOpen(tenantId, locationId);
    return {
      tool: 'org.hours',
      summary: abierto
        ? 'El local está abierto ahora mismo.'
        : 'El local está cerrado ahora mismo.',
      kinds: ['hours'],
      values: [],
    };
  }
}
