import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { AI_PROVIDER } from '../ai.tokens.js';
import { EMBEDDING_DIMENSIONS, type AiProvider } from '../domain/ai-provider.js';

/**
 * Fuentes de conocimiento y RAG (spec 19 §2.4, T5.23).
 *
 * La regla que manda: **filtro obligatorio por `tenant_id`**, y no como un
 * `WHERE` que hay que acordarse de poner. La búsqueda por similitud es
 * `ORDER BY embedding <=> $1 LIMIT k`, y si el aislamiento dependiera de
 * recordar el filtro, olvidarlo **devolvería el material de otro negocio
 * ordenado por parecido**: sin error, sin aviso, y con la respuesta puesta en
 * boca del agente de un competidor. Con RLS sobre `ai_source_chunks`,
 * olvidarlo devuelve cero filas.
 *
 * El catálogo NO se indexa aquí. Es herramienta viva (T5.26): un precio
 * indexado hace seis meses es exactamente lo que RN-AIA-01 existe para impedir.
 */

export interface SourceChunk {
  sourceId: string;
  title: string;
  content: string;
  /** Distancia coseno: menor es más parecido. */
  distance: number;
}

/** Tamaño de fragmento, en caracteres. */
const TAMANO_FRAGMENTO = 700;

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
  ) {}

  /** Crea o reemplaza una fuente y la reindexa. */
  async upsertSource(
    tenantId: string,
    input: {
      id?: string | undefined;
      brandId?: string | undefined;
      title: string;
      topic?: string | undefined;
      body: string;
      actorId?: string | undefined;
    },
  ): Promise<{ id: string; chunks: number }> {
    if (input.body.trim().length < 10) {
      throw new ValidationError('La fuente necesita algo de contenido.');
    }

    const fragmentos = trocear(input.body);
    // Los embeddings se piden FUERA de la transacción: es una llamada de red a
    // un tercero y mantener abierta una transacción mientras se espera es como
    // se agota un pool de conexiones en el peor momento.
    const vectores = await this.provider.embed(fragmentos);

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO ai_sources (tenant_id, id, brand_id, title, topic, body)
         VALUES ($1, COALESCE($2, gen_random_uuid()), $3, $4, $5, $6)
         ON CONFLICT (tenant_id, id) DO UPDATE
           SET title = EXCLUDED.title,
               topic = EXCLUDED.topic,
               body = EXCLUDED.body,
               version = ai_sources.version + 1,
               updated_at = now()
         RETURNING id`,
        [
          tenantId,
          input.id ?? null,
          input.brandId ?? null,
          input.title,
          input.topic ?? null,
          input.body,
        ],
      );
      const id = rows[0]!.id;

      // Reindexar es borrar y reescribir. Actualizar en sitio dejaría
      // fragmentos viejos de un texto que ya no existe, y el agente citaría una
      // política derogada como vigente.
      await ctx.client.query('DELETE FROM ai_source_chunks WHERE source_id = $1', [
        id,
      ]);

      for (let i = 0; i < fragmentos.length; i++) {
        await ctx.client.query(
          `INSERT INTO ai_source_chunks
             (tenant_id, source_id, chunk_index, content, embedding)
           VALUES ($1,$2,$3,$4,$5::vector)`,
          [tenantId, id, i, fragmentos[i], aVector(vectores[i]!)],
        );
      }

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'ai.source_upserted',
        resourceType: 'ai_source',
        resourceId: id,
        data: { title: input.title, chunks: fragmentos.length },
      });

      return { id, chunks: fragmentos.length };
    });
  }

  /**
   * Busca los fragmentos más parecidos.
   *
   * El `WHERE` por tenant NO está: lo pone RLS. Es deliberado y es la prueba de
   * que el aislamiento no depende de esta consulta — si alguien copia esta
   * función a otro sitio y se deja un filtro, sigue sin ver nada ajeno.
   */
  async search(
    tenantId: string,
    query: string,
    options: { brandId?: string | undefined; limit?: number } = {},
  ): Promise<SourceChunk[]> {
    const [vector] = await this.provider.embed([query]);
    if (!vector) return [];

    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        source_id: string;
        title: string;
        content: string;
        distance: number;
      }>(
        `SELECT c.source_id, s.title, c.content,
                (c.embedding <=> $1::vector) AS distance
           FROM ai_source_chunks c
           JOIN ai_sources s ON s.id = c.source_id
          WHERE s.active
            AND (s.brand_id IS NULL OR s.brand_id = $2)
          ORDER BY c.embedding <=> $1::vector
          LIMIT $3`,
        [aVector(vector), options.brandId ?? null, options.limit ?? 3],
      );
      return rows.map((r) => ({
        sourceId: r.source_id,
        title: r.title,
        content: r.content,
        distance: Number(r.distance),
      }));
    });
  }

  /** Contador de uso: el dueño ve qué material sirve y cuál sobra. */
  async markUsed(tenantId: string, sourceIds: readonly string[]): Promise<void> {
    if (sourceIds.length === 0) return;
    await withTenant(this.pool, tenantId, ({ client }) =>
      client.query(
        'UPDATE ai_sources SET use_count = use_count + 1 WHERE id = ANY($1::uuid[])',
        [[...new Set(sourceIds)]],
      ),
    );
  }

  async listSources(
    tenantId: string,
  ): Promise<
    Array<{
      id: string;
      title: string;
      topic: string | null;
      version: number;
      useCount: number;
      active: boolean;
    }>
  > {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        title: string;
        topic: string | null;
        version: number;
        use_count: number;
        active: boolean;
      }>(
        `SELECT id, title, topic, version, use_count, active
           FROM ai_sources ORDER BY title`,
      );
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        topic: r.topic,
        version: r.version,
        useCount: r.use_count,
        active: r.active,
      }));
    });
  }

  async deleteSource(tenantId: string, id: string): Promise<void> {
    await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rowCount } = await client.query(
        'DELETE FROM ai_sources WHERE id = $1',
        [id],
      );
      if ((rowCount ?? 0) === 0) throw new NotFoundError('Fuente no encontrada.');
    });
  }
}

/**
 * Trocea por párrafos, respetando el tamaño máximo.
 *
 * Por párrafo y no por número fijo de caracteres: cortar una política a mitad
 * de frase da un fragmento que, recuperado solo, dice lo contrario de lo que
 * dice el texto entero.
 */
function trocear(body: string): string[] {
  const parrafos = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const salida: string[] = [];
  let actual = '';
  for (const p of parrafos) {
    if (actual && actual.length + p.length > TAMANO_FRAGMENTO) {
      salida.push(actual);
      actual = p;
    } else {
      actual = actual ? `${actual}\n\n${p}` : p;
    }
  }
  if (actual) salida.push(actual);

  // Un párrafo más largo que el máximo se parte a lo bruto: es preferible a
  // enviar al modelo un fragmento de diez mil caracteres.
  return salida.flatMap((s) =>
    s.length <= TAMANO_FRAGMENTO * 2
      ? [s]
      : (s.match(new RegExp(`.{1,${TAMANO_FRAGMENTO}}`, 'gs')) ?? [s]),
  );
}

/** `[0.1, -0.2]` → `'[0.1,-0.2]'`, que es como pgvector lo espera. */
function aVector(v: readonly number[]): string {
  if (v.length !== EMBEDDING_DIMENSIONS) {
    throw new ValidationError(
      `El embedding tiene ${v.length} dimensiones y el esquema espera ${EMBEDDING_DIMENSIONS}.`,
    );
  }
  return `[${v.join(',')}]`;
}
