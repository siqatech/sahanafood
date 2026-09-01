import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  ConversationsService,
  type ConversationView,
  type MessageView,
} from '../app/conversations.service.js';

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

const messageSchema = z.object({
  kind: z.enum(['text', 'template', 'note']),
  text: z.string().min(1).max(4096).optional(),
  templateName: z.string().min(1).max(120).optional(),
  costEstimateMinor: z.number().int().nonnegative().optional(),
});

const quickReplySchema = z.object({
  // El atajo es corto A PROPÓSITO: se teclea mientras el cliente espera. Sin
  // espacios, para que se pueda escribir de un tirón y buscar sin ambigüedad.
  shortcut: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(
      /^[^\s]+$/,
      'El atajo va sin espacios: se teclea con el cliente esperando.',
    ),
  body: z.string().trim().min(1).max(4096),
  // Sin marca vale para todas. Es lo correcto en un «ya lo anoto» y lo
  // incorrecto en una dirección de recojo, que es distinta en cada marca.
  brandId: z.string().uuid().optional(),
});

const orderSchema = z.object({
  locationId: z.string().uuid(),
  customerName: z.string().min(2).max(120).optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive().max(99),
        modifierOptionIds: z.array(z.string().uuid()).optional(),
        notes: z.string().max(280).optional(),
      }),
    )
    .min(1),
});

/** Bandeja omnicanal (spec 18 §4). */
@Controller({ path: 'conversations', version: '1' })
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @RequirePermission('conversations.read')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('queue') queue?: string,
    @Query('assignee') assignee?: string,
    @Query('brand') brand?: string,
    @Query('search') search?: string,
  ): Promise<ConversationView[]> {
    return this.conversations.listConversations(req.auth!.tid, {
      status,
      queue,
      assigneeId: assignee,
      brandId: brand,
      search,
    });
  }

  @Get(':id')
  @RequirePermission('conversations.read')
  async get(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ConversationView> {
    return this.conversations.getConversation(req.auth!.tid, id);
  }

  /**
   * El hilo. Las notas internas NO salen salvo que se pidan (RN-CNV-07).
   *
   * Que haya que pedirlas explícitamente es lo que hace difícil filtrarlas por
   * accidente: quien consulta sin declararlo suele ir a enseñar el hilo.
   */
  @Get(':id/messages')
  @RequirePermission('conversations.read')
  async messages(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('includeNotes') includeNotes?: string,
  ): Promise<MessageView[]> {
    return this.conversations.listMessages(req.auth!.tid, id, {
      includeNotes: includeNotes === 'true',
    });
  }

  @Post(':id/messages')
  @RequirePermission('conversations.reply')
  async send(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<MessageView> {
    const input = parse(messageSchema, body);
    return this.conversations.sendMessage(req.auth!.tid, id, {
      ...input,
      authorType: 'agent',
      authorId: req.auth!.sub,
    });
  }

  @Post(':id/assign')
  @RequirePermission('conversations.assign')
  async assign(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const input = parse(z.object({ assigneeId: z.string().uuid() }), body);
    await this.conversations.assign(
      req.auth!.tid,
      id,
      input.assigneeId,
      req.auth!.sub,
    );
    return { ok: true };
  }

  @Post(':id/resolve')
  @RequirePermission('conversations.reply')
  async resolve(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.conversations.resolve(req.auth!.tid, id, req.auth!.sub);
    return { ok: true };
  }

  /**
   * Crear un pedido desde la bandeja (RN-CNV-05).
   *
   * Pasa por `OrderingService`, nunca por SQL: es lo que garantiza que este
   * pedido lleve las mismas validaciones, totales y eventos que uno de la
   * tienda. Exige `orders.create` además de poder responder, porque crear un
   * pedido en nombre de alguien es cobrarle.
   */
  @Post(':id/orders')
  @RequirePermission('orders.create')
  async createOrder(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ orderId: string }> {
    const input = parse(orderSchema, body);
    return this.conversations.createOrderFromInbox(req.auth!.tid, id, {
      ...input,
      agentId: req.auth!.sub,
    });
  }

  @Get(':id/quick-replies')
  @RequirePermission('conversations.read')
  async quickReplies(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<unknown> {
    const conv = await this.conversations.getConversation(req.auth!.tid, id);
    return this.conversations.quickReplies(req.auth!.tid, conv.brandId);
  }
}

/**
 * Las respuestas rápidas se administran FUERA de una conversación concreta.
 *
 * Se leen desde el hilo —`GET /conversations/:id/quick-replies` filtra por la
 * marca de esa conversación—, pero escribirlas es configuración del negocio y
 * no debe exigir tener un cliente delante. Un controlador aparte, además, deja
 * que gestionarlas pida `conversations.manage` y usarlas solo
 * `conversations.read`: quien atiende las usa, quien manda las escribe.
 */
@Controller({ path: 'quick-replies', version: '1' })
export class QuickRepliesController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @RequirePermission('conversations.read')
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('brandId') brandId?: string,
  ): Promise<unknown> {
    return this.conversations.quickReplies(req.auth!.tid, brandId);
  }

  @Post()
  @RequirePermission('conversations.manage')
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const input = parse(quickReplySchema, body);
    return this.conversations.createQuickReply(req.auth!.tid, input);
  }

  @Delete(':id')
  @RequirePermission('conversations.manage')
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.conversations.deleteQuickReply(req.auth!.tid, id);
    return { ok: true };
  }
}
