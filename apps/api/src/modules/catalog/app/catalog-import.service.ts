import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { Money } from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';
import { ValidationError } from '../../../common/errors.js';
import { productosDeCsv } from '../../../database/carta-csv.js';
import { CatalogAdminService } from './catalog-admin.service.js';

/**
 * La carta pegada desde un Excel (docs/26 §2: «importador de carta: pegar desde
 * Excel/CSV con mapeo asistido»).
 *
 * ## Por qué otra vez, si ya había importador
 *
 * Lo había, pero como **script de línea de comandos**: transforma un CSV en el
 * `negocio.json` que aplica `setup-business`. Sirve para dar de alta clientes
 * desde nuestra máquina y no sirve para nada al dueño que ya está dentro del
 * panel con su hoja abierta en otra pestaña. Y ese es el caso que decide la
 * métrica de docs/26 —alta hasta primera venta en menos de un día—, porque
 * escribir 180 platos a mano es una tarde.
 *
 * ## Sin segundo camino de escritura
 *
 * `import-csv.ts` explica por qué no escribe en la base: «un segundo camino de
 * escritura al catálogo sería un segundo sitio donde los precios pueden salir
 * distintos». La objeción es correcta y aquí se respeta de dos maneras:
 *
 *  · **Se parsea con SU misma función** (`productosDeCsv`), así que las reglas
 *    del Excel peruano —`;` como separador, `45,90` con coma decimal, SKU
 *    repetido es error y no «gana el último»— y los mensajes que nombran fila y
 *    columna son exactamente los mismos, ya probados sin base de datos.
 *  · **Se escribe por `CatalogAdminService`**, el mismo upsert que usa el
 *    formulario de un solo plato. La importación es un lote de esas altas, no
 *    una vía paralela.
 *
 * ## Y nada se aplica sin que alguien lo mire
 *
 * docs/26 lo pide literal para la variante con IA —«nunca publicar sin revisión
 * humana»— y specs/ux/03 pide «publicación explícita con diff». De ahí
 * `dryRun`: **el mismo código** calcula la vista previa y aplica. Dos rutas
 * distintas para previsualizar y para escribir acabarían divergiendo, y lo que
 * el dueño aprobó no sería lo que se guardó.
 */

/** Qué le va a pasar a una fila de la hoja. */
export type EfectoDeFila = 'nuevo' | 'actualiza' | 'igual';

export interface FilaImportada {
  sku: string | null;
  nombre: string;
  categoria: string | null;
  /** Precio base como cadena decimal, o `null` si la fila no trae precio. */
  precioBase: string | null;
  /** El precio que ya había, para poder verlo al lado del nuevo. */
  precioAnterior: string | null;
  efecto: EfectoDeFila;
}

export interface ResultadoDeImportacion {
  /** true = no se escribió nada; esto es solo la vista previa. */
  simulacion: boolean;
  filas: FilaImportada[];
  nuevos: number;
  actualizados: number;
  sinCambios: number;
  categoriasNuevas: string[];
}

@Injectable()
export class CatalogImportService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly admin: CatalogAdminService,
  ) {}

  async importar(
    tenantId: string,
    input: {
      brandId: string;
      csv: string;
      dryRun: boolean;
      actorId?: string | undefined;
    },
  ): Promise<ResultadoDeImportacion> {
    if (input.csv.trim() === '') {
      throw new ValidationError('Pega la carta antes de importar.');
    }

    // El parseo va PRIMERO y entero: si la fila 140 tiene un precio imposible,
    // no se escribe ninguna de las 139 anteriores. Una carta a medio importar
    // es peor que no haberla importado — nadie sabe dónde se cortó.
    let parseado;
    try {
      parseado = productosDeCsv(input.csv, 'la carta pegada');
    } catch (error) {
      // El mensaje del importador ya nombra fila y columna; se pasa tal cual.
      throw new ValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }

    const existentes = await this.admin.listProducts(tenantId, {
      brandId: input.brandId,
    });

    // Por SKU si lo hay y por nombre si no: es la misma clave natural que usa
    // el upsert, y usar otra aquí haría que la vista previa dijera «nuevo» de
    // algo que el upsert va a actualizar.
    const clave = (sku: string | null | undefined, nombre: string): string =>
      (sku && sku !== '' ? `sku:${sku}` : `nombre:${nombre}`).toLowerCase();

    const porClave = new Map(
      existentes.map((p) => [clave(p.sku, p.name), p] as const),
    );
    const categoriasQueYaHay = new Set(
      existentes
        .map((p) => p.categoryName?.toLowerCase())
        .filter((n): n is string => Boolean(n)),
    );

    const filas: FilaImportada[] = parseado.productos.map((p) => {
      const previo = porClave.get(clave(p.sku, p.nombre));
      // Normalizado por `Money`: la hoja trae «32,00» y la base guarda
      // «32.0000». Enseñar los dos tal cual pondría el precio nuevo y el viejo
      // uno al lado del otro con distinto número de decimales, y eso se lee
      // como si hubieran cambiado cuando no.
      const nuevoPrecio = p.precios['base']
        ? Money.parse(p.precios['base']).toDecimalString()
        : null;
      const precioAnterior =
        previo?.prices.find((x) => x.channel === null && x.locationId === null)
          ?.price ?? null;

      let efecto: EfectoDeFila;
      if (!previo) {
        efecto = 'nuevo';
      } else if (
        nuevoPrecio !== null &&
        !mismoImporte(nuevoPrecio, precioAnterior)
      ) {
        efecto = 'actualiza';
      } else if (previo.name !== p.nombre) {
        // Renombrar por SKU es el caso que justifica que el SKU sea la clave:
        // sin él, un plato renombrado se duplicaría y el original se quedaría
        // en la carta.
        efecto = 'actualiza';
      } else {
        efecto = 'igual';
      }

      return {
        sku: p.sku ?? null,
        nombre: p.nombre,
        categoria: p.categoria ?? null,
        precioBase: nuevoPrecio,
        precioAnterior,
        efecto,
      };
    });

    const categoriasNuevas = parseado.categorias
      .map((c) => c.nombre)
      .filter((n) => !categoriasQueYaHay.has(n.toLowerCase()));

    const resumen: ResultadoDeImportacion = {
      simulacion: input.dryRun,
      filas,
      nuevos: filas.filter((f) => f.efecto === 'nuevo').length,
      actualizados: filas.filter((f) => f.efecto === 'actualiza').length,
      sinCambios: filas.filter((f) => f.efecto === 'igual').length,
      categoriasNuevas,
    };

    if (input.dryRun) return resumen;

    // ------------------------------------------------------------- Aplicar
    //
    // Las categorías primero: un producto referencia la suya por nombre, y
    // crearlas después dejaría a los productos de la primera pasada sin
    // categoría hasta que alguien volviera a importar.
    const idDeCategoria = new Map<string, string>();
    for (const c of parseado.categorias) {
      const creada = await this.admin.upsertCategory(tenantId, {
        brandId: input.brandId,
        name: c.nombre,
        sortOrder: c.orden,
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      });
      idDeCategoria.set(c.nombre.toLowerCase(), creada.id);
    }

    for (const p of parseado.productos) {
      const categoryId = p.categoria
        ? (idDeCategoria.get(p.categoria.toLowerCase()) ?? null)
        : null;

      const creado = await this.admin.upsertProduct(tenantId, {
        brandId: input.brandId,
        name: p.nombre,
        categoryId,
        ...(p.sku !== undefined ? { sku: p.sku } : {}),
        ...(p.descripcion !== undefined ? { description: p.descripcion } : {}),
        ...(p.alergenos !== undefined ? { allergens: p.alergenos } : {}),
        ...(p.minutosPreparacion !== undefined
          ? { prepMinutes: p.minutosPreparacion }
          : {}),
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      });

      for (const [canal, importe] of Object.entries(p.precios)) {
        await this.admin.setPrice(tenantId, {
          productId: creado.id,
          // `base` en la hoja es el precio sin canal propio, que en la API es
          // `channel` nulo.
          channel: canal === 'base' ? null : canal,
          priceMinor: Money.parse(importe).minorUnits,
          ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        });
      }
    }

    await this.auditarImportacion(tenantId, input, resumen);
    return { ...resumen, simulacion: false };
  }

  private async auditarImportacion(
    tenantId: string,
    input: { brandId: string; actorId?: string | undefined },
    resumen: ResultadoDeImportacion,
  ): Promise<void> {
    // Queda en el histórico porque una importación puede cambiar el precio de
    // ciento ochenta platos de una vez: es, con diferencia, la acción de mayor
    // alcance del panel, y «¿quién subió esta carta?» tiene que tener respuesta.
    await withTenant(this.pool, tenantId, async ({ client }) => {
      await client.query(
        `INSERT INTO audit_log
           (tenant_id, actor_type, actor_id, action, resource_type, resource_id, data)
         VALUES ($1, $2, $3, 'catalog.imported', 'brand', $4, $5::jsonb)`,
        [
          tenantId,
          input.actorId ? 'user' : 'system',
          input.actorId ?? null,
          input.brandId,
          JSON.stringify({
            nuevos: resumen.nuevos,
            actualizados: resumen.actualizados,
            sinCambios: resumen.sinCambios,
          }),
        ],
      );
    });
  }
}

/**
 * ¿Son el mismo importe dos cadenas decimales?
 *
 * Por `Money` y no por comparación de texto: `45.90` y `45.9000` son el mismo
 * precio, y compararlos como cadenas marcaría «actualiza» toda la carta en cada
 * importación — con lo que el diff dejaría de significar nada.
 */
function mismoImporte(a: string, b: string | null): boolean {
  if (b === null) return false;
  try {
    return Money.parse(a).minorUnits === Money.parse(b).minorUnits;
  } catch {
    return false;
  }
}
