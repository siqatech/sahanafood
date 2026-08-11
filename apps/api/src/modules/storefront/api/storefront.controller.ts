import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
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
  MAX_CANTIDAD_LINEA,
  StorefrontService,
  type CartView,
  type CouponView,
  type StorefrontContext,
  type CheckoutResult,
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
  quantity: z.number().int().positive().max(MAX_CANTIDAD_LINEA),
  modifierOptionIds: z.array(z.string().uuid()).optional(),
  notes: z.string().max(280).optional(),
});

const cuponSchema = z.object({
  id: z.string().uuid().optional(),
  brandId: z.string().uuid(),
  code: z.string().min(3).max(40),
  kind: z.enum(['percent', 'fixed', 'free_delivery']),
  // Puntos básicos ENTEROS, como todo porcentaje del sistema: 1000 = 10 %. Un
  // decimal aquí sería la única puerta por la que entra coma flotante a un
  // descuento.
  percentBps: z.number().int().min(1).max(10000).optional(),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/)
    .optional(),
  minOrder: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/)
    .optional(),
  maxUses: z.number().int().positive().optional(),
  validUntil: z.string().datetime().optional(),
  active: z.boolean().optional(),
  isWelcome: z.boolean().optional(),
});

const cantidadSchema = z.object({
  // El cero se admite y significa «quítalo»: es lo que hace el botón «−» al
  // llegar a uno, y así el carrito no necesita dos acciones para lo mismo.
  quantity: z.number().int().min(0).max(MAX_CANTIDAD_LINEA),
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

  /**
   * Los dominios del negocio.
   *
   * Con `storefront.read`, no con `manage_domains`: mirar dónde vive la tienda
   * es una consulta, y quien atiende pedidos necesita poder responder «entra en
   * tal dirección» sin permiso para cambiarla.
   */
  @Get('domains')
  @RequirePermission('storefront.read')
  async listDomains(@Req() req: AuthenticatedRequest): Promise<unknown> {
    return this.storefront.listDomains(req.auth!.tid);
  }

  @Post('domains')
  @RequirePermission('storefront.manage_domains')
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

  /** Las promociones del negocio. */
  @Get('coupons')
  @RequirePermission('storefront.read')
  async listCoupons(@Req() req: AuthenticatedRequest): Promise<CouponView[]> {
    return this.storefront.listCoupons(req.auth!.tid);
  }

  /**
   * Crear o cambiar una promoción.
   *
   * Con `storefront.manage_promotions` y no con `storefront.read`: un descuento
   * es dinero que se deja de cobrar, así que decidirlo no es lo mismo que
   * mirarlo. Propietario y administrador lo tienen por comodín; el supervisor,
   * no.
   */
  @Post('coupons')
  @RequirePermission('storefront.manage_promotions')
  async upsertCoupon(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<CouponView> {
    const input = parse(cuponSchema, body);
    return this.storefront.upsertCoupon(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('domains/:id/verify')
  @RequirePermission('storefront.manage_domains')
  async verifyDomain(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.storefront.verifyDomain(req.auth!.tid, id);
    return { ok: true };
  }
}

/**
 * El host del visitante.
 *
 * `x-forwarded-host` manda sobre `host` porque la API siempre está detrás de
 * algo: el proxy en producción y el servidor de Next en desarrollo. Sin esto,
 * `host` sería el del balanceador y **todas las tiendas servirían la misma
 * marca** — el fallo más caro posible aquí, y silencioso, porque la página
 * carga igual.
 *
 * Que un llamante directo pueda inventarse la cabecera no añade riesgo: lo
 * único que consigue es ver la tienda pública de otra marca, que es pública
 * precisamente. No abre nada que no abriera escribir ese dominio en el
 * navegador. La cabecera NO decide nada que no sea qué escaparate se enseña.
 */
function hostDelVisitante(forwarded?: string, host?: string): string {
  // Puede venir con varios saltos: `cliente.com, interno` — manda el primero.
  const primero = forwarded?.split(',')[0]?.trim();
  return primero || host || '';
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
  async context(
    @Headers('x-forwarded-host') forwarded: string,
    @Headers('host') host: string,
  ): Promise<StorefrontContext> {
    return this.storefront.resolveHost(hostDelVisitante(forwarded, host));
  }

  @Get('catalog')
  async catalog(
    @Headers('x-forwarded-host') forwarded: string,
    @Headers('host') host: string,
  ): Promise<unknown> {
    return this.storefront.getPublicCatalog(hostDelVisitante(forwarded, host));
  }

  @Post('carts')
  async createCart(
    @Headers('x-forwarded-host') forwarded: string,
    @Headers('host') host: string,
  ): Promise<{ token: string }> {
    return this.storefront.createCart(hostDelVisitante(forwarded, host));
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

  /**
   * Cambia la cantidad de una línea. `0` la quita.
   *
   * Es `PATCH` y no `POST` porque modifica una línea que ya existe, y la
   * cantidad viaja en el cuerpo y no en la URL para que no acabe en los logs
   * del proxy junto al token del carrito.
   */
  @Patch('carts/:token/lines/:lineId')
  async setLineQuantity(
    @Param('token') token: string,
    @Param('lineId') lineId: string,
    @Body() body: unknown,
  ): Promise<CartView> {
    const { quantity } = parse(cantidadSchema, body);
    return this.storefront.setLineQuantity(token, lineId, quantity);
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
    @Body() body: unknown,
  ): Promise<CheckoutResult> {
    // `on_delivery` por defecto: con el pago en línea por defecto, una tienda
    // sin pasarela conectada rompería el checkout de todos sus compradores el
    // día que se despliegue esto.
    const input = parse(
      z.object({ payment: z.enum(['online', 'on_delivery']).optional() }),
      body ?? {},
    );
    return this.storefront.checkout(token, {
      payment: input.payment ?? 'on_delivery',
    });
  }
}
