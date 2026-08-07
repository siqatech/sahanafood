import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { CONFIG, type AppConfig } from '../../../config/config.js';
import {
  withTenant,
  withIntegrationLookup,
  type TenantContext,
} from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { CredentialCipher, redactCredentials } from './credential-cipher.js';
import {
  afterAttempt,
  circuitAllows,
  circuitState,
  type CircuitSnapshot,
  type CircuitState,
} from '../domain/circuit-breaker.js';

/**
 * Conexiones por tenant: credenciales, mapeo de catálogo y salud del conector
 * (spec 13). No procesa pedidos —eso es `IngestionService`—; su trabajo es que
 * el resto del sistema nunca vea un secreto en claro ni un tenant equivocado.
 */

export interface ConnectionView {
  id: string;
  provider: string;
  channel: string;
  brandId: string;
  locationId: string;
  status: string;
  webhookToken: string;
  circuit: CircuitState;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  credentials: Record<string, '***'>;
}

/** Conexión resuelta desde el webhook, con el secreto ya descifrado. */
export interface ResolvedConnection {
  id: string;
  tenantId: string;
  provider: string;
  channel: string;
  brandId: string;
  locationId: string;
  status: string;
  signingSecret: string;
}

export const SIGNING_SECRET_FIELD = 'signing_secret';

@Injectable()
export class ConnectionService {
  private readonly cipher: CredentialCipher;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) config: AppConfig,
  ) {
    // La clave se valida en `loadConfig`, que además impide arrancar en
    // producción con el valor por defecto del repositorio: una clave ausente o
    // pública debe frenar el despliegue, no descubrirse al primer webhook.
    this.cipher = new CredentialCipher(config.credentialsMasterKey);
  }

  async create(
    tenantId: string,
    input: {
      provider: string;
      channel: string;
      brandId: string;
      locationId: string;
      signingSecret: string;
      config?: Record<string, unknown> | undefined;
      actorId?: string | undefined;
    },
  ): Promise<ConnectionView> {
    if (input.signingSecret.length < 16) {
      throw new ValidationError(
        'El secreto de firma debe tener al menos 16 caracteres.',
      );
    }
    // 32 bytes en base64url: suficiente para que el token de la URL no se
    // adivine ni aparezca por fuerza bruta en los logs de un proxy.
    const webhookToken = randomBytes(32).toString('base64url');

    return withTenant(this.pool, tenantId, async (ctx) => {
      const [row] = await ctx.db
        .insert(schema.integrationConnections)
        .values({
          tenantId,
          provider: input.provider,
          channel: input.channel,
          brandId: input.brandId,
          locationId: input.locationId,
          webhookToken,
          credentials: this.cipher.encryptAll(tenantId, {
            [SIGNING_SECRET_FIELD]: input.signingSecret,
          }),
          config: input.config ?? {},
        })
        .returning();

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'integration.connection_created',
        resourceType: 'integration_connection',
        resourceId: row!.id,
        // El secreto NO entra en auditoría: el registro de auditoría se exporta
        // y se lee, y ahí es donde acaban filtrándose las credenciales.
        data: { provider: input.provider, channel: input.channel },
      });

      return this.toView(row!);
    });
  }

  async list(tenantId: string): Promise<ConnectionView[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db.select().from(schema.integrationConnections);
      return rows.map((r) => this.toView(r));
    });
  }

  /**
   * Resuelve la conexión a partir del token público de la URL del webhook.
   *
   * Es el ÚNICO punto que usa el escape `app.integration_lookup`, y no
   * autoriza nada por sí solo: devuelve el secreto para que el llamador
   * verifique la firma. Token válido + firma inválida = 401 sin encolar.
   */
  async resolveByWebhookToken(
    webhookToken: string,
  ): Promise<ResolvedConnection | undefined> {
    const row = await withIntegrationLookup(this.pool, async ({ db }) => {
      const rows = await db
        .select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.webhookToken, webhookToken))
        .limit(1);
      return rows[0];
    });
    if (!row) return undefined;

    return {
      id: row.id,
      tenantId: row.tenantId,
      provider: row.provider,
      channel: row.channel,
      brandId: row.brandId,
      locationId: row.locationId,
      status: row.status,
      signingSecret: this.cipher.decryptField(
        row.tenantId,
        row.credentials as Record<string, unknown>,
        SIGNING_SECRET_FIELD,
      ),
    };
  }

  // ------------------------------------------------------- Mapeo de catálogo

  async mapSku(
    tenantId: string,
    input: {
      connectionId: string;
      externalSku: string;
      productId?: string | undefined;
      modifierOptionId?: string | undefined;
    },
  ): Promise<void> {
    if (!input.productId === !input.modifierOptionId) {
      throw new ValidationError(
        'Un SKU externo mapea a un producto O a una opción de modificador, no a ambos ni a ninguno.',
      );
    }
    await withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.db
        .insert(schema.integrationCatalogMap)
        .values({
          tenantId,
          connectionId: input.connectionId,
          externalSku: input.externalSku,
          productId: input.productId ?? null,
          modifierOptionId: input.modifierOptionId ?? null,
        })
        .onConflictDoNothing();
    });
  }

  /**
   * Mapa completo de la conexión. Se carga entero en vez de consultar SKU a
   * SKU: son decenas de filas y la ingesta ocurre en el camino crítico de un
   * pedido.
   */
  async loadCatalogMap(
    ctx: TenantContext,
    connectionId: string,
  ): Promise<
    Map<string, { productId: string | null; modifierOptionId: string | null }>
  > {
    const rows = await ctx.db
      .select()
      .from(schema.integrationCatalogMap)
      .where(eq(schema.integrationCatalogMap.connectionId, connectionId));
    return new Map(
      rows.map((r) => [
        r.externalSku,
        { productId: r.productId, modifierOptionId: r.modifierOptionId },
      ]),
    );
  }

  // ------------------------------------------------- Cortacircuitos (RN-INT-03)

  async circuitSnapshot(
    tenantId: string,
    connectionId: string,
  ): Promise<CircuitSnapshot> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, connectionId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new NotFoundError('Conexión no encontrada.');
      return {
        consecutiveFailures: row.consecutiveFailures,
        circuitOpenedAt: row.circuitOpenedAt,
      };
    });
  }

  /** ¿Se puede llamar al proveedor ahora? */
  async canCall(
    tenantId: string,
    connectionId: string,
    now = new Date(),
  ): Promise<boolean> {
    return circuitAllows(
      await this.circuitSnapshot(tenantId, connectionId),
      now,
    );
  }

  /** Registra el resultado de una llamada saliente y persiste el circuito. */
  async recordAttempt(
    tenantId: string,
    connectionId: string,
    outcome: 'success' | 'failure',
    now = new Date(),
  ): Promise<CircuitState> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        consecutive_failures: number;
        circuit_opened_at: Date | null;
      }>(
        // FOR UPDATE: dos fallos simultáneos contarían uno solo si ambos leyeran
        // el mismo valor, y el circuito no llegaría a abrirse nunca.
        'SELECT consecutive_failures, circuit_opened_at FROM int_connections WHERE id = $1 FOR UPDATE',
        [connectionId],
      );
      const actual = rows[0];
      if (!actual) throw new NotFoundError('Conexión no encontrada.');

      const siguiente = afterAttempt(
        {
          consecutiveFailures: actual.consecutive_failures,
          circuitOpenedAt: actual.circuit_opened_at,
        },
        outcome,
        now,
      );

      await ctx.db
        .update(schema.integrationConnections)
        .set({
          consecutiveFailures: siguiente.consecutiveFailures,
          circuitOpenedAt: siguiente.circuitOpenedAt,
          updatedAt: now,
          ...(outcome === 'success' ? { lastSuccessAt: now } : {}),
        })
        .where(eq(schema.integrationConnections.id, connectionId));

      return circuitState(siguiente, now);
    });
  }

  /** Pausar una conexión NO detiene las demás (RN-INT-03). */
  async setStatus(
    tenantId: string,
    connectionId: string,
    status: 'active' | 'paused' | 'disabled',
    actorId?: string,
  ): Promise<ConnectionView> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const [row] = await ctx.db
        .update(schema.integrationConnections)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            eq(schema.integrationConnections.id, connectionId),
            eq(schema.integrationConnections.tenantId, tenantId),
          ),
        )
        .returning();
      if (!row) throw new NotFoundError('Conexión no encontrada.');

      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: 'integration.connection_status_changed',
        resourceType: 'integration_connection',
        resourceId: connectionId,
        data: { status },
      });
      return this.toView(row);
    });
  }

  private toView(
    row: typeof schema.integrationConnections.$inferSelect,
  ): ConnectionView {
    const seguro = redactCredentials(row);
    return {
      id: row.id,
      provider: row.provider,
      channel: row.channel,
      brandId: row.brandId,
      locationId: row.locationId,
      status: row.status,
      webhookToken: row.webhookToken,
      circuit: circuitState(
        {
          consecutiveFailures: row.consecutiveFailures,
          circuitOpenedAt: row.circuitOpenedAt,
        },
        new Date(),
      ),
      consecutiveFailures: row.consecutiveFailures,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      credentials: seguro.credentials,
    };
  }
}
