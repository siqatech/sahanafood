import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  ConnectionService,
  type ConnectionView,
} from '../app/connection.service.js';
import { IngestionService } from '../app/ingestion.service.js';

/** Entrada de la cola de muertos tal como la ve el panel. */
type DeadLetterView = Awaited<
  ReturnType<IngestionService['deadLetters']>
>[number];

/** Administración de conexiones y salud de la ingesta (spec 13). */

const createSchema = z.object({
  provider: z.string().min(1),
  channel: z.string().min(1),
  brandId: z.string().uuid(),
  locationId: z.string().uuid(),
  signingSecret: z.string().min(16),
  config: z.record(z.unknown()).optional(),
});

const mapSchema = z
  .object({
    connectionId: z.string().uuid(),
    externalSku: z.string().min(1),
    productId: z.string().uuid().optional(),
    modifierOptionId: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.productId) !== Boolean(v.modifierOptionId), {
    message:
      'Indica productId O modifierOptionId (exactamente uno de los dos).',
  });

const statusSchema = z.object({
  status: z.enum(['active', 'paused', 'disabled']),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => i.message).join(' '),
      { errors: result.error.issues },
    );
  }
  return result.data;
}

@Controller({ path: 'integrations', version: '1' })
export class IntegrationsController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly ingestion: IngestionService,
  ) {}

  @Get('connections')
  @RequirePermission('integrations.read')
  async list(@Req() req: AuthenticatedRequest): Promise<ConnectionView[]> {
    // El servicio devuelve las credenciales ya redactadas: el secreto de firma
    // no sale de la BD ni para el propietario del tenant.
    return this.connections.list(req.auth!.tid);
  }

  @Post('connections')
  @RequirePermission('integrations.manage')
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ConnectionView> {
    const input = parse(createSchema, body);
    return this.connections.create(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('connections/:id/status')
  @RequirePermission('integrations.manage')
  async setStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ConnectionView> {
    const { status } = parse(statusSchema, body);
    return this.connections.setStatus(req.auth!.tid, id, status, req.auth!.sub);
  }

  @Post('catalog-map')
  @RequirePermission('integrations.manage')
  async mapSku(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const input = parse(mapSchema, body);
    await this.connections.mapSku(req.auth!.tid, input);
    return { ok: true };
  }

  /**
   * Cola de muertos. Debe estar SIEMPRE vacía: cada entrada es un webhook que
   * ni siquiera se pudo apartar a la bandeja de excepciones, es decir, la única
   * forma en que este sistema puede perder un pedido.
   */
  @Get('dead-letters')
  @RequirePermission('integrations.read')
  async deadLetters(
    @Req() req: AuthenticatedRequest,
  ): Promise<DeadLetterView[]> {
    return this.ingestion.deadLetters(req.auth!.tid);
  }

  @Post('dead-letters/:id/retry')
  @RequirePermission('integrations.manage')
  async retry(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.ingestion.retryDeadLetter(req.auth!.tid, id);
    return { ok: true };
  }
}
