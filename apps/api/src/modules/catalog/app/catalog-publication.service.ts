import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  diffCatalogVersions,
  type CatalogSnapshot,
  type CatalogVersionDiff,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import { NotFoundError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { enqueueEvent } from '../../../events/outbox.js';
import { CatalogService, type ResolvedCatalog } from './catalog.service.js';

/**
 * Publicación versionada del catálogo (spec 04, T4.06).
 *
 * Publicar es congelar lo que hoy se ofrece en un canal y darle un número. Eso
 * resuelve dos problemas que el catálogo vivo no puede:
 *
 * · **El POS offline necesita algo estable.** Vende horas sin red contra lo que
 *   descargó. Si eso fuera «lo último que hubiera», dos cajas del mismo local
 *   podrían cobrar precios distintos y ninguna sabría cuál es la buena.
 * · **Poder responder qué se ofrecía el martes a las 20:00** cuando un cliente
 *   reclame. Un catálogo que solo tiene presente no puede contestar eso.
 *
 * Y una restricción explícita de la spec: **publicar no bloquea ventas**. Por
 * eso la publicación solo INSERTA: no toca productos ni precios, no toma
 * cerrojos sobre ellos, y un pedido en curso no espera a nadie.
 */

export interface PublishedVersion {
  id: string;
  brandId: string;
  channel: string;
  version: number;
  checksum: string;
  productCount: number;
  publishedAt: string;
  /** true si no había cambios y se devolvió la versión que ya existía. */
  reused?: boolean;
}

export interface PublishedVersionWithSnapshot extends PublishedVersion {
  snapshot: CatalogSnapshot;
}

/**
 * Instantánea comparable: solo lo que define la OFERTA. Se excluye
 * `resolvedAt` a propósito — cambia en cada publicación y haría que el checksum
 * nunca coincidiera, generando una versión nueva cada vez que alguien pulsa el
 * botón aunque no haya cambiado nada.
 */
function toSnapshot(resolved: ResolvedCatalog): CatalogSnapshot {
  return {
    brandId: resolved.brandId,
    channel: resolved.channel,
    locationId: resolved.locationId,
    categories: resolved.categories,
    products: resolved.products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      categoryId: p.categoryId,
      imageUrl: p.imageUrl,
      allergens: p.allergens,
      prepMinutes: p.prepMinutes,
      isCombo: p.isCombo,
      // El diff compara `priceMinor`; se guarda plano para que el POS no tenga
      // que entender la representación interna de Money al comparar.
      priceMinor: p.price.minorUnits,
      currency: p.price.currency,
      available: true, // lo resuelto ya excluye pausados y sin precio
      modifierGroups: p.modifierGroups,
    })),
  };
}

/**
 * Huella estable del contenido. Las claves se ordenan antes de serializar
 * porque el orden de un objeto JS depende de cómo se construyó: sin ordenarlas,
 * un refactor inocuo del servicio cambiaría el checksum de un catálogo
 * idéntico y publicaría una versión falsa.
 */
function checksumOf(snapshot: CatalogSnapshot): string {
  const estable = JSON.stringify(snapshot, (_clave, valor: unknown) => {
    if (
      typeof valor === 'object' &&
      valor !== null &&
      !Array.isArray(valor)
    ) {
      const obj = valor as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = obj[k];
          return acc;
        }, {});
    }
    return valor;
  });
  return createHash('sha256').update(estable).digest('hex');
}

@Injectable()
export class CatalogPublicationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Publica el catálogo vigente de (marca, canal) como versión inmutable.
   *
   * Si el contenido es idéntico a la última versión, devuelve ESA en vez de
   * crear otra: publicar tres veces seguidas por nerviosismo no debe hacer que
   * la PWA se descargue tres catálogos iguales.
   */
  async publish(
    tenantId: string,
    input: {
      brandId: string;
      channel: string;
      locationId?: string | undefined;
      actorId?: string | undefined;
      notes?: string | undefined;
      traceId?: string | undefined;
    },
  ): Promise<PublishedVersion> {
    // La resolución ocurre FUERA de la transacción de escritura: es la parte
    // lenta y no necesita cerrojo. Publicar no puede frenar una venta.
    const resuelto = await this.catalog.getResolvedCatalog(tenantId, {
      brandId: input.brandId,
      channel: input.channel,
      ...(input.locationId !== undefined
        ? { locationId: input.locationId }
        : {}),
    });
    const snapshot = toSnapshot(resuelto);
    const checksum = checksumOf(snapshot);

    return withTenant(this.pool, tenantId, async (ctx) => {
      const ultima = await this.latestRow(ctx.client, {
        tenantId,
        brandId: input.brandId,
        channel: input.channel,
      });

      if (ultima && ultima.checksum === checksum) {
        return {
          id: ultima.id,
          brandId: input.brandId,
          channel: input.channel,
          version: ultima.version,
          checksum: ultima.checksum,
          productCount: ultima.product_count,
          publishedAt: ultima.published_at.toISOString(),
          reused: true,
        };
      }

      const version = (ultima?.version ?? 0) + 1;

      // El índice único (tenant, marca, canal, versión) es lo que impide de
      // verdad que dos publicaciones simultáneas reclamen el mismo número: si
      // ambas leen la misma «última», la segunda choca y reintenta con la
      // siguiente. La garantía la da la base, no el orden de llegada.
      const [fila] = await ctx.db
        .insert(schema.catalogVersions)
        .values({
          tenantId,
          brandId: input.brandId,
          channel: input.channel,
          version,
          snapshot,
          checksum,
          productCount: snapshot.products.length,
          publishedBy: input.actorId ?? null,
          notes: input.notes ?? null,
        })
        .returning({
          id: schema.catalogVersions.id,
          publishedAt: schema.catalogVersions.publishedAt,
        });

      await enqueueEvent(ctx, {
        aggregateType: 'catalog',
        aggregateId: `${input.brandId}:${input.channel}`,
        eventType: 'catalog.published',
        payload: {
          brandId: input.brandId,
          channel: input.channel,
          version,
          checksum,
          productCount: snapshot.products.length,
        },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'catalog.published',
        resourceType: 'catalog_version',
        resourceId: fila!.id,
        ...(input.notes !== undefined ? { reason: input.notes } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: {
          brandId: input.brandId,
          channel: input.channel,
          version,
          productCount: snapshot.products.length,
        },
      });

      return {
        id: fila!.id,
        brandId: input.brandId,
        channel: input.channel,
        version,
        checksum,
        productCount: snapshot.products.length,
        publishedAt: fila!.publishedAt.toISOString(),
      };
    });
  }

  /** Versiones publicadas de un canal, de la más reciente a la más antigua. */
  async listVersions(
    tenantId: string,
    query: { brandId: string; channel: string; limit?: number },
  ): Promise<PublishedVersion[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const filas = await ctx.db
        .select({
          id: schema.catalogVersions.id,
          brandId: schema.catalogVersions.brandId,
          channel: schema.catalogVersions.channel,
          version: schema.catalogVersions.version,
          checksum: schema.catalogVersions.checksum,
          productCount: schema.catalogVersions.productCount,
          publishedAt: schema.catalogVersions.publishedAt,
        })
        .from(schema.catalogVersions)
        .where(
          and(
            eq(schema.catalogVersions.brandId, query.brandId),
            eq(schema.catalogVersions.channel, query.channel),
          ),
        )
        .orderBy(desc(schema.catalogVersions.version))
        .limit(Math.min(query.limit ?? 50, 200));

      return filas.map((f) => ({
        ...f,
        publishedAt: f.publishedAt.toISOString(),
      }));
    });
  }

  /**
   * Descarga una versión concreta, o la última si no se indica número. Esto es
   * lo que el POS guarda en disco para operar sin red.
   */
  async getVersion(
    tenantId: string,
    query: { brandId: string; channel: string; version?: number },
  ): Promise<PublishedVersionWithSnapshot> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const condiciones = [
        eq(schema.catalogVersions.brandId, query.brandId),
        eq(schema.catalogVersions.channel, query.channel),
      ];
      if (query.version !== undefined) {
        condiciones.push(eq(schema.catalogVersions.version, query.version));
      }

      const filas = await ctx.db
        .select()
        .from(schema.catalogVersions)
        .where(and(...condiciones))
        .orderBy(desc(schema.catalogVersions.version))
        .limit(1);

      const fila = filas[0];
      if (!fila) {
        throw new NotFoundError(
          query.version !== undefined
            ? `No existe la versión ${query.version} del catálogo de este canal.`
            : 'Este canal todavía no tiene ninguna versión publicada.',
        );
      }

      return {
        id: fila.id,
        brandId: fila.brandId,
        channel: fila.channel,
        version: fila.version,
        checksum: fila.checksum,
        productCount: fila.productCount,
        publishedAt: fila.publishedAt.toISOString(),
        snapshot: fila.snapshot as CatalogSnapshot,
      };
    });
  }

  /**
   * Diferencias entre dos versiones (criterio de aceptación de la spec 04).
   *
   * Es lo que descarga el POS al reconectar en vez del catálogo entero: en un
   * local con conexión mala y cola en el mostrador, la diferencia es
   * sincronizar en un segundo o en treinta.
   */
  async diff(
    tenantId: string,
    query: { brandId: string; channel: string; from: number; to: number },
  ): Promise<CatalogVersionDiff & { from: number; to: number }> {
    const [desde, hasta] = await Promise.all([
      this.getVersion(tenantId, {
        brandId: query.brandId,
        channel: query.channel,
        version: query.from,
      }),
      this.getVersion(tenantId, {
        brandId: query.brandId,
        channel: query.channel,
        version: query.to,
      }),
    ]);

    // El cálculo lo hace `@sahana/domain`: el mismo código que aplicará el POS
    // al otro lado. Dos implementaciones divergirían y el POS acabaría con un
    // catálogo que no es el del servidor.
    return {
      ...diffCatalogVersions(desde.snapshot, hasta.snapshot),
      from: query.from,
      to: query.to,
    };
  }

  private async latestRow(
    client: { query: <T>(t: string, p?: unknown[]) => Promise<{ rows: T[] }> },
    key: { tenantId: string; brandId: string; channel: string },
  ): Promise<
    | {
        id: string;
        version: number;
        checksum: string;
        product_count: number;
        published_at: Date;
      }
    | undefined
  > {
    const { rows } = await client.query<{
      id: string;
      version: number;
      checksum: string;
      product_count: number;
      published_at: Date;
    }>(
      `SELECT id, version, checksum, product_count, published_at
         FROM cat_catalog_versions
        WHERE brand_id = $1 AND channel = $2
        ORDER BY version DESC
        LIMIT 1`,
      [key.brandId, key.channel],
    );
    return rows[0];
  }
}
