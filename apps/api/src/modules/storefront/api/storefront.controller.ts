import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  StorefrontService,
  type CartView,
  type StorefrontContext,
} from '../app/storefront.service.js';

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

const domainSchema = z.object({
  brandId: z.string().uuid(),
  host: z.string().min(4).max(253),
  isSubdomain: z.boolean().optional(),
});

const addLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(99),
  modifierOptionIds: z.array(z.string().uuid()).optional(),
  notes: z.string().max(280).optional(),
});

const addressSchema = z.object({
  address: z.string().min(5).max(280),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const customerSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(6).max(20),
  notes: z.string().max(280).optional(),
  /**
   * Consentimiento de marketing: su propia casilla, con su propio texto
   * (RN-STO-04, RN-T10). No es una sub-casilla de «acepto los términos», y el
   * texto se guarda porque un booleano no demuestra qué aceptó nadie.
   */
  marketingConsent: z.boolean().optional(),
  marketingConsentText: z.string().max(500).optional(),
});

/** Administración de dominios de tienda. Requiere sesión del panel. */
@Controller({ path: 'storefront', version: '1' })
export class StorefrontAdminController {
  constructor(private readonly storefront: StorefrontService) {}

  @Post('domains')
  @RequirePermission('catalog.manage')
  async registerDomain(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{
    id: string;
    host: string;
    status: string;
    verificationToken: string | null;
  }> {
    const input = parse(domainSchema, body);
    return this.storefront.registerDomain(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('domains/:id/verify')
  @RequirePermission('catalog.manage')
  async verifyDomain(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.storefront.verifyDomain(req.auth!.tid, id);
    return { ok: true };
  }
}

/**
 * La tienda. TODO público: quien compra no tiene cuenta.
 *
 * El tenant sale del **host**, nunca de un parámetro. Es la diferencia entre
 * una tienda multi-marca y un buscador de catálogos ajenos: si la marca se
 * pudiera pedir por query string, cualquiera vería el catálogo y los precios de
 * cualquier competidor desde su propio dominio.
 */
@Controller({ path: 'shop', version: '1' })
export class ShopController {
  constructor(private readonly storefront: StorefrontService) {}

  @Get('context')
  async context(@Headers('host') host: string): Promise<StorefrontContext> {
    return this.storefront.resolveHost(host ?? '');
  }

  @Get('catalog')
  async catalog(@Headers('host') host: string): Promise<unknown> {
    return this.storefront.getPublicCatalog(host ?? '');
  }

  @Post('carts')
  async createCart(
    @Headers('host') host: string,
  ): Promise<{ token: string }> {
    return this.storefront.createCart(host ?? '');
  }

  @Get('carts/:token')
  async getCart(@Param('token') token: string): Promise<CartView> {
    return this.storefront.getCart(token);
  }

  @Post('carts/:token/lines')
  async addLine(
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<CartView> {
    return this.storefront.addLine(token, parse(addLineSchema, body));
  }

  @Delete('carts/:token/lines/:lineId')
  async removeLine(
    @Param('token') token: string,
    @Param('lineId') lineId: string,
  ): Promise<CartView> {
    return this.storefront.removeLine(token, lineId);
  }

  @Post('carts/:token/address')
  async setAddress(
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<CartView> {
    return this.storefront.setAddress(token, parse(addressSchema, body));
  }

  @Post('carts/:token/customer')
  async setCustomer(
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<CartView> {
    return this.storefront.setCustomer(token, parse(customerSchema, body));
  }

  @Post('carts/:token/coupon')
  async applyCoupon(
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<CartView> {
    const input = parse(z.object({ code: z.string().min(1).max(40) }), body);
    return this.storefront.applyCouponCode(token, input.code);
  }

  @Post('carts/:token/checkout')
  async checkout(
    @Param('token') token: string,
  ): Promise<{ orderId: string; total: string }> {
    return this.storefront.checkout(token);
  }
}
