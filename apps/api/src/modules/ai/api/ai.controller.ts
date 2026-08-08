import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import { AgentService, type AgentReply } from '../app/agent.service.js';
import { AgentConfigService, type ConfigView } from '../app/agent-config.service.js';
import { KnowledgeService } from '../app/knowledge.service.js';

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

const conditionSchema = z.object({
  kind: z.enum([
    'asks_about',
    'asks_first_time_about',
    'contains',
    'wants',
    'sentiment_negative',
  ]),
  value: z.string().max(200),
});

const actionSchema = z.object({
  kind: z.enum([
    'reply',
    'send_products',
    'send_location',
    'send_link',
    'capture_field',
    'tag',
    'handoff',
    'pause_ai',
  ]),
  value: z.string().max(2000),
});

@Controller({ path: 'ai', version: '1' })
export class AiController {
  constructor(
    private readonly agent: AgentService,
    private readonly config: AgentConfigService,
    private readonly knowledge: KnowledgeService,
  ) {}

  // ------------------------------------------------------- Configuración

  @Get('config')
  @RequirePermission('ai.read')
  async draft(
    @Req() req: AuthenticatedRequest,
    @Query('brand') brand?: string,
  ): Promise<ConfigView> {
    if (!brand) throw new ValidationError('Se requiere el parámetro brand.');
    return this.config.getDraft(req.auth!.tid, brand);
  }

  @Put('config/:id')
  @RequirePermission('ai.manage')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ConfigView> {
    const input = parse(
      z.object({
        identity: z
          .object({
            name: z.string().max(80).optional(),
            role: z.string().max(200).optional(),
            personality: z.string().max(1000).optional(),
            tone: z.enum(['amistoso', 'formal', 'juvenil']).optional(),
            length: z.enum(['corta', 'media']).optional(),
            emojis: z.boolean().optional(),
          })
          .optional(),
        guidelines: z.array(z.string().max(500)).max(30).optional(),
        limits: z
          .object({
            forbiddenTopics: z.array(z.string().max(120)).max(50).optional(),
            handoffMessage: z.string().max(500).optional(),
          })
          .optional(),
        enabled: z.boolean().optional(),
      }),
      body,
    );
    return this.config.updateDraft(req.auth!.tid, id, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('config/:id/rules')
  @RequirePermission('ai.manage')
  async addRule(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    const input = parse(
      z.object({
        name: z.string().min(2).max(120),
        priority: z.number().int().min(0).max(10_000).optional(),
        matchMode: z.enum(['any', 'all']).optional(),
        conditions: z.array(conditionSchema).min(1).max(10),
        actions: z.array(actionSchema).min(1).max(10),
        activeFromMinute: z.number().int().min(0).max(1439).nullable().optional(),
        activeToMinute: z.number().int().min(0).max(1439).nullable().optional(),
      }),
      body,
    );
    return this.config.addRule(req.auth!.tid, id, input);
  }

  /** Publicar = versión inmutable (spec 19 §2.8). */
  @Post('config/:id/publish')
  @RequirePermission('ai.manage')
  async publish(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ConfigView> {
    return this.config.publish(req.auth!.tid, id, req.auth!.sub);
  }

  /** Rollback en un clic: se apunta a otra versión, no se copia nada. */
  @Post('config/:id/rollback')
  @RequirePermission('ai.manage')
  async rollback(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ConfigView> {
    return this.config.rollback(req.auth!.tid, id, req.auth!.sub);
  }

  @Get('config/versions')
  @RequirePermission('ai.read')
  async versions(
    @Req() req: AuthenticatedRequest,
    @Query('brand') brand?: string,
  ): Promise<unknown> {
    if (!brand) throw new ValidationError('Se requiere el parámetro brand.');
    return this.config.listVersions(req.auth!.tid, brand);
  }

  // --------------------------------------------------------------- Fuentes

  @Get('sources')
  @RequirePermission('ai.read')
  async sources(@Req() req: AuthenticatedRequest): Promise<unknown> {
    return this.knowledge.listSources(req.auth!.tid);
  }

  @Post('sources')
  @RequirePermission('ai.manage')
  async upsertSource(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ id: string; chunks: number }> {
    const input = parse(
      z.object({
        id: z.string().uuid().optional(),
        brandId: z.string().uuid().optional(),
        title: z.string().min(2).max(200),
        topic: z.string().max(80).optional(),
        body: z.string().min(10).max(50_000),
      }),
      body,
    );
    return this.knowledge.upsertSource(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Delete('sources/:id')
  @RequirePermission('ai.manage')
  async deleteSource(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.knowledge.deleteSource(req.auth!.tid, id);
    return { ok: true };
  }

  // ------------------------------------------------------ Sandbox y traza

  /**
   * Sandbox: probar el agente sin que un cliente sea el conejillo de indias.
   *
   * Es el patrón «vista previa» de la spec 19 §2.8, y existe porque la
   * alternativa —editar en vivo y ver qué pasa— se prueba con clientes reales.
   * Devuelve la respuesta Y la traza: qué regla disparó, qué fuentes se usaron,
   * qué dijo el validador.
   */
  @Post('sandbox')
  @RequirePermission('ai.manage')
  async sandbox(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<AgentReply> {
    const input = parse(
      z.object({
        conversationId: z.string().uuid(),
        brandId: z.string().uuid(),
        text: z.string().min(1).max(2000),
        minuteOfDay: z.number().int().min(0).max(1439).optional(),
      }),
      body,
    );
    return this.agent.respond(req.auth!.tid, input);
  }

  @Get('traces/:conversationId')
  @RequirePermission('ai.read')
  async traces(
    @Req() req: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
  ): Promise<unknown> {
    return this.agent.traces(req.auth!.tid, conversationId);
  }

  // ----------------------------------------------------------- Presupuesto

  @Get('budget')
  @RequirePermission('ai.read')
  async budget(@Req() req: AuthenticatedRequest): Promise<unknown> {
    return this.agent.budget(req.auth!.tid);
  }

  @Put('budget')
  @RequirePermission('ai.manage')
  async setBudget(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parse(
      z.object({ limitCredits: z.number().int().min(0).max(10_000_000) }),
      body,
    );
    await this.agent.setBudget(req.auth!.tid, input.limitCredits);
    return this.agent.budget(req.auth!.tid);
  }
}
