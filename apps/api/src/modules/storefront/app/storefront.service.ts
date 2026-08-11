import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  Money,
  applyCoupon,
  validateAndPriceModifiers,
  ModifierError,
  type Coupon,
  type CouponRejection,
  type ModifierSelection,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import {
  withTenant,
  withPublicToken,
  type TenantContext,
} from '../../../database/rls.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';

import { recordAudit } from '../../audit/index.js';
import {
  PublicTokensService,
  PublicTokenError,
} from '../../../common/public-tokens.service.js';
import { OrganizationService } from '../../organization/index.js';
import { OrderingService } from '../../ordering/index.js';
import {
  CatalogService,
  type ResolvedCatalog,
  type ResolvedProduct,
} from '../../catalog/index.js';
import { PaymentsService } from '../../payments/index.js';

/**
 * Tienda web (spec 11, T5.08–T5.13).
 *
 * El carrito vive AQUÍ, en el servidor, y no en el navegador. Es la decisión
 * que ordena el módulo entero y va contra lo que hace media internet, así que
 * conviene dejar los tres motivos escritos:
 *
 *  1. **RN-STO-02 exige validar al agregar Y al confirmar.** Un carrito que solo
 *     existe en el cliente no se puede revalidar: llega al checkout con precios
 *     de hace veinte minutos y productos que se agotaron mientras el cliente
 *     decidía. Y el aviso tiene que ser claro —«se agotó el pollo a la brasa»—,
 *     no un error genérico que hace abandonar la compra.
 *  2. **«Pago fallido → carrito recuperable»** es criterio de aceptación. Un
 *     carrito en `localStorage` se pierde al cerrar la pestaña, que es
 *     exactamente lo que hace la gente cuando le rebotan la tarjeta.
 *  3. **El precio lo pone el servidor. Siempre.** Un carrito de cliente es una
 *     lista de deseos, no una factura.
 */

/** Lo que ve un cliente al abrir una tienda. Sin ningún id interno de más. */
export interface StorefrontContext {
  brandId: string;
  brandName: string;
  host: string;
  /**
   * La oferta que se anuncia a quien entra por primera vez, ya redactada.
   *
   * El TEXTO se compone aquí y no en la tienda porque describe un descuento, y
   * un porcentaje mal escrito en el escaparate es una promesa que la caja no va
   * a cumplir. La tienda solo lo pinta.
   */
  welcome: { code: string; label: string; minOrder: string | null } | null;
  /**
   * El aspecto de la tienda de esta marca.
   *
   * Va en el contexto —y no en una llamada aparte— porque se necesita para
   * pintar el primer píxel: pedirlo después haría que la tienda apareciera con
   * los colores de Sahana y cambiara a los del cliente medio segundo más tarde,
   * que es peor que no personalizarla.
   */
  branding: Branding;
  /**
   * Cómo puede pagar el cliente en esta tienda.
   *
   * Lo decide el NEGOCIO y lo dice el servidor. La tienda no adivina: enseñar
   * un botón de Apple Pay que no cobra —porque el negocio no tiene la cuenta o
   * su pasarela no lo soporta— es peor que no enseñarlo, porque el cliente lo
   * pulsa y abandona.
   */
  payment: {
    /** `true` si hay pasarela conectada y activa. */
    online: boolean;
    /** Medios en línea disponibles: card, yape, plin, apple_pay, google_pay. */
    methods: string[];
    /** Pagar al recibir sigue siendo lo más usado en Perú. */
    onDelivery: boolean;
  };
}

/** Aspecto de una tienda. Los nulos significan «usa lo de Sahana». */
export interface Branding {
  displayName: string | null;
  tagline: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  colorBase: string | null;
  colorHover: string | null;
  colorTexto: string | null;
}

/** Una promoción, como la administra el dueño. */
export interface CouponView {
  id: string;
  brandId: string | null;
  code: string;
  kind: string;
  percentBps: number | null;
  amount: string | null;
  minOrder: string;
  maxUses: number | null;
  usedCount: number;
  validUntil: string | null;
  active: boolean;
  isWelcome: boolean;
  /** El mismo texto que vería un cliente. */
  label: string;
}

export interface CartLineView {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  /** true si el producto ya no está disponible: se muestra, no se borra solo. */
  unavailable: boolean;
}

export interface CheckoutResult {
  orderId: string;
  total: string;
  /** Solo con pago en línea. Es lo que la tienda necesita para redirigir. */
  payment?: {
    /** Referencia OPACA: nunca el id interno de la intención. */
    reference: string;
    checkoutUrl: string | null;
    expiresAt: string;
  };
}

export interface CartView {
  token: string;
  status: string;
  fulfillment: string;
  lines: CartLineView[];
  subtotal: string;
  deliveryFee: string;
  discount: string;
  total: string;
  currency: string;
  coupon: { code: string; applied: boolean; reason?: string } | null;
  /** Problemas que impiden confirmar. Vacío = se puede pagar. */
  blockers: Array<{ code: string; detail: string }>;
}

/**
 * Tope de unidades por línea de carrito.
 *
 * No es una regla de negocio: es un freno. Sin él, el campo de cantidad acepta
 * lo que se le mande —el carrito es público y sin autenticar— y un número
 * absurdo se convierte en una comanda absurda que alguien tiene que cancelar a
 * mano, o en un cálculo de stock que deja la cocina en negativo. Cincuenta
 * unidades de un mismo plato cubre de sobra una reunión familiar; por encima de
 * eso, es un pedido para hablarlo por teléfono.
 */
export const MAX_CANTIDAD_LINEA = 50;

/**
 * Cómo se cuenta un descuento en palabras.
 *
 * Vive en el servidor, junto al cálculo, y no en la tienda. Duplicarlo en el
 * navegador es cómo se llega a un escaparate que anuncia el 15 % mientras la
 * caja aplica el 10: el cliente lo descubre en el total y la culpa es del
 * local. Aquí lo escribe quien tiene los datos.
 */
function describirCupon(c: {
  kind: string;
  percent_bps: number | null;
  amount: string | null;
  min_order: string;
}): string {
  const minimo =
    Number(c.min_order) > 0
      ? ` en pedidos desde S/ ${Number(c.min_order).toFixed(2)}`
      : '';
  if (c.kind === 'percent') {
    // Puntos básicos enteros → porcentaje. 1000 bps = 10 %.
    const pct = (c.percent_bps ?? 0) / 100;
    const texto = Number.isInteger(pct) ? String(pct) : pct.toFixed(2);
    return `${texto} % de descuento${minimo}`;
  }
  if (c.kind === 'fixed') {
    return `S/ ${Number(c.amount ?? 0).toFixed(2)} de descuento${minimo}`;
  }
  return `Envío gratis${minimo}`;
}

/**
 * Un color de marca, o nada.
 *
 * Solo `#rrggbb`. Es estrecho a propósito: este valor acaba **dentro de una
 * hoja de estilos** que se sirve en la tienda, así que cualquier cosa que no
 * sea un color es texto de un tercero entrando en el CSS. Aceptar
 * `red; } body { display:none` sería dejar que quien administra una marca
 * decidiera cómo se ve —o si se ve— la página.
 *
 * Se descartan también los nombres de color (`red`) y `rgb()`: no aportan nada
 * que el hexadecimal no dé, y cada formato admitido es una expresión más que
 * validar bien.
 */
function colorValido(valor: string | undefined): string | null {
  if (!valor) return null;
  const limpio = valor.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(limpio)) {
    throw new ValidationError(
      `"${valor}" no es un color. Se escribe en hexadecimal, así: #c8102e.`,
    );
  }
  return limpio;
}

/**
 * Una URL de imagen, o nada.
 *
 * Solo `https://`. Una imagen por `http://` en una tienda que va por HTTPS la
 * bloquea el navegador —contenido mixto— y el logo del cliente simplemente no
 * aparece, sin ningún error visible. Y `javascript:` o `data:` en un atributo
 * `src` es la otra mitad del mismo problema.
 */
function imagenValida(valor: string | undefined): string | null {
  if (!valor) return null;
  const limpio = valor.trim();
  if (!/^https:\/\/[^\s"'<>]+$/.test(limpio)) {
    throw new ValidationError(
      'La imagen tiene que ser una dirección https:// — por http:// el navegador la bloquea y no se ve.',
    );
  }
  return limpio;
}

const CART_TTL_HOURS = 72;

@Injectable()
export class StorefrontService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly publicTokens: PublicTokensService,
    private readonly organization: OrganizationService,
    private readonly ordering: OrderingService,
    private readonly catalog: CatalogService,
    private readonly payments: PaymentsService,
  ) {}

  // ------------------------------------------------------------- Dominios

  /**
   * Registra un host para una marca (RN-STO-03).
   *
   * Un subdominio nuestro queda verificado y activo al instante: el DNS lo
   * controlamos nosotros. Un dominio propio queda **pendiente** con su token de
   * verificación, y hasta que el CNAME no se compruebe **no sirve la tienda** —
   * servir el catálogo de una marca en un host que aún no es suyo es
   * exactamente cómo se secuestra una tienda.
   */
  async registerDomain(
    tenantId: string,
    input: {
      brandId: string;
      host: string;
      isSubdomain?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<{
    id: string;
    host: string;
    status: string;
    verificationToken: string | null;
  }> {
    const host = input.host.trim().toLowerCase();
    if (
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
        host,
      )
    ) {
      throw new ValidationError(`"${input.host}" no es un host válido.`);
    }

    const esSubdominio = input.isSubdomain ?? host.endsWith('.sahana.food');
    const token = esSubdominio
      ? null
      : `sahana-verify=${randomBytes(16).toString('hex')}`;

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ id: string; status: string }>(
        `INSERT INTO sto_domains
           (tenant_id, brand_id, host, is_subdomain, verification_token,
            verified_at, status)
         VALUES ($1,$2,$3,$4,$5,
                 CASE WHEN $4 THEN now() ELSE NULL END,
                 CASE WHEN $4 THEN 'active' ELSE 'pending' END)
         RETURNING id, status`,
        [tenantId, input.brandId, host, esSubdominio, token],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'storefront.domain_registered',
        resourceType: 'storefront_domain',
        resourceId: rows[0]!.id,
        data: { host, isSubdomain: esSubdominio },
      });

      return {
        id: rows[0]!.id,
        host,
        status: rows[0]!.status,
        verificationToken: token,
      };
    });
  }

  /**
   * Los dominios del negocio, con su estado y lo que falta para activarlos.
   *
   * Faltaba, y la consecuencia es que el dato más importante de la tienda —**en
   * qué dirección vive**— no lo devolvía ninguna ruta. Se podía registrar un
   * dominio y verificarlo, y no había forma de saber cuál había quedado
   * registrado, ni si estaba activo, ni cuál era el token que hay que poner en
   * el DNS. Quien registrara uno y cerrara la pestaña perdía el token.
   *
   * El token se devuelve entero: **no es un secreto**, es un valor que hay que
   * publicar en un registro TXT para demostrar que el dominio es tuyo. Ocultarlo
   * haría imposible el paso que existe para verificarlo.
   */
  async listDomains(tenantId: string): Promise<
    Array<{
      id: string;
      brandId: string;
      host: string;
      status: string;
      isSubdomain: boolean;
      verificationToken: string | null;
      verifiedAt: string | null;
    }>
  > {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        brand_id: string;
        host: string;
        status: string;
        is_subdomain: boolean;
        verification_token: string | null;
        verified_at: Date | null;
      }>(
        `SELECT id, brand_id, host, status, is_subdomain,
                verification_token, verified_at
           FROM sto_domains ORDER BY host`,
      );
      return rows.map((r) => ({
        id: r.id,
        brandId: r.brand_id,
        host: r.host,
        status: r.status,
        isSubdomain: r.is_subdomain,
        verificationToken: r.verification_token,
        verifiedAt: r.verified_at?.toISOString() ?? null,
      }));
    });
  }

  /**
   * Da por verificado un dominio propio.
   *
   * La comprobación DNS real es de infraestructura y llega con T3.16; aquí se
   * modela el efecto para que el resto del flujo sea probable de punta a punta.
   * Lo importante ya está: sin este paso, `status` no puede ser `active`, y la
   * restricción que lo garantiza vive en la BASE, no en este método.
   */
  async verifyDomain(tenantId: string, domainId: string): Promise<void> {
    await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rowCount } = await client.query(
        `UPDATE sto_domains
            SET verified_at = now(), status = 'active', updated_at = now()
          WHERE id = $1 AND status <> 'disabled'`,
        [domainId],
      );
      if ((rowCount ?? 0) === 0)
        throw new NotFoundError('Dominio no encontrado.');
    });
  }

  /**
   * Registra el dominio de una tienda **si no lo está ya**, y lo apunta a la
   * marca indicada.
   *
   * `registerDomain` no es idempotente a propósito —un alta es un alta—, pero
   * la configuración por archivo se aplica varias veces y ahí la segunda pasada
   * chocaría contra el índice único del host, abortando el resto de la
   * configuración por algo que ya estaba bien. Esto es lo que usa
   * `setup-business`.
   *
   * `verified` solo debería venir en true cuando quien ejecuta el comando tiene
   * acceso al servidor y al DNS del cliente: dar por verificado un dominio que
   * no lo está es servir el catálogo de una marca en un host ajeno.
   */
  async ensureDomain(
    tenantId: string,
    input: {
      brandId: string;
      host: string;
      isSubdomain?: boolean | undefined;
      verified?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<{ id: string; host: string; status: string }> {
    const host = input.host.trim().toLowerCase();

    const existente = await withTenant(
      this.pool,
      tenantId,
      async ({ client }) => {
        const { rows } = await client.query<{ id: string; status: string }>(
          'SELECT id, status FROM sto_domains WHERE lower(host) = $1',
          [host],
        );
        return rows[0];
      },
    );

    let id: string;
    let status: string;
    if (existente) {
      // Reapuntar a otra marca es legítimo —un cliente que cambia el nombre
      // comercial—, y no reapuntar sería peor: el archivo diría una cosa y la
      // tienda serviría otra.
      await withTenant(this.pool, tenantId, async ({ client }) => {
        await client.query(
          'UPDATE sto_domains SET brand_id = $2, updated_at = now() WHERE id = $1',
          [existente.id, input.brandId],
        );
      });
      id = existente.id;
      status = existente.status;
    } else {
      const alta = await this.registerDomain(tenantId, input);
      id = alta.id;
      status = alta.status;
    }

    if (input.verified && status !== 'active') {
      await this.verifyDomain(tenantId, id);
      status = 'active';
    }
    return { id, host, status };
  }

  /**
   * Resuelve qué marca sirve un host. PÚBLICO: llega sin sesión.
   *
   * Solo dominios **activos**. Uno pendiente devuelve lo mismo que uno que no
   * existe: si distinguiera, cualquiera podría averiguar qué dominios están a
   * medio configurar y adelantarse a apuntarlos.
   */
  async resolveHost(host: string): Promise<StorefrontContext> {
    const normalizado = host.trim().toLowerCase().split(':')[0] ?? '';

    const fila = await withPublicToken(this.pool, async ({ client }) => {
      const { rows } = await client.query<{
        tenant_id: string;
        brand_id: string;
        host: string;
      }>(
        `SELECT tenant_id, brand_id, host FROM sto_domains
          WHERE lower(host) = $1 AND status = 'active' LIMIT 1`,
        [normalizado],
      );
      return rows[0];
    });
    if (!fila)
      throw new NotFoundError('No hay ninguna tienda en este dominio.');

    return this.contextoDeMarca(fila.tenant_id, fila.brand_id, fila.host);
  }

  /**
   * Lo que ve una tienda de una marca, venga por dominio o por clave.
   *
   * Está extraído para que las DOS vías devuelvan exactamente lo mismo. Con el
   * cuerpo duplicado, el día que se añada un campo se añade en una y no en la
   * otra, y la tienda de un cliente se queda sin él sin que nadie lo note.
   */
  private async contextoDeMarca(
    tenantId: string,
    brandId: string,
    host: string,
  ): Promise<StorefrontContext> {
    const marca = await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ name: string }>(
        'SELECT name FROM org_brands WHERE id = $1',
        [brandId],
      );
      return rows[0];
    });
    if (!marca)
      throw new NotFoundError('No hay ninguna tienda en este dominio.');

    // La oferta de bienvenida se lee con la marca: es parte de lo que la
    // tienda necesita para pintar la primera pantalla, y pedirla aparte
    // costaría un viaje más justo en la carga que decide si alguien se queda.
    const bienvenida = await withTenant(
      this.pool,
      tenantId,
      async ({ client }) => {
        const { rows } = await client.query<{
          code: string;
          kind: string;
          percent_bps: number | null;
          amount: string | null;
          min_order: string;
        }>(
          `SELECT code, kind, percent_bps, amount, min_order
             FROM sto_coupons
            WHERE brand_id = $1
              AND is_welcome AND active
              AND (valid_from IS NULL OR valid_from <= now())
              AND (valid_until IS NULL OR valid_until >= now())
              AND (max_uses IS NULL OR used_count < max_uses)
            LIMIT 1`,
          [brandId],
        );
        return rows[0];
      },
    );

    const marcaVisual = await withTenant(
      this.pool,
      tenantId,
      async ({ client }) => {
        const { rows } = await client.query<{
          display_name: string | null;
          tagline: string | null;
          logo_url: string | null;
          cover_url: string | null;
          color_base: string | null;
          color_hover: string | null;
          color_texto: string | null;
        }>(
          `SELECT display_name, tagline, logo_url, cover_url,
                  color_base, color_hover, color_texto
             FROM sto_branding WHERE brand_id = $1`,
          [brandId],
        );
        return rows[0];
      },
    );

    // Medios de pago: salen de la conexión de pasarela del negocio. Sin
    // conexión activa, la tienda solo puede ofrecer pago contra entrega — y
    // decirlo es mejor que enseñar un botón de tarjeta que no lleva a ninguna
    // parte.
    const medios = await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ methods: string[] }>(
        `SELECT methods FROM pay_connections
          WHERE status = 'active' AND (brand_id IS NULL OR brand_id = $1)
          ORDER BY brand_id NULLS LAST LIMIT 1`,
        [brandId],
      );
      return rows[0]?.methods ?? [];
    });

    return {
      brandId,
      // El nombre que se anuncia manda sobre el interno: «Pollería El Buen
      // Sabor S.A.C.» es la razón social, y en la cabecera va «El Buen Sabor».
      brandName: marcaVisual?.display_name?.trim() || marca.name,
      host,
      branding: {
        displayName: marcaVisual?.display_name ?? null,
        tagline: marcaVisual?.tagline ?? null,
        logoUrl: marcaVisual?.logo_url ?? null,
        coverUrl: marcaVisual?.cover_url ?? null,
        colorBase: marcaVisual?.color_base ?? null,
        colorHover: marcaVisual?.color_hover ?? null,
        colorTexto: marcaVisual?.color_texto ?? null,
      },
      // Un cupón caducado o agotado NO se anuncia: prometer un descuento que la
      // caja va a rechazar es peor que no ofrecer ninguno. La consulta ya los
      // descarta, y por eso las mismas condiciones que valida `applyCoupon`
      // están aquí arriba.
      payment: {
        online: medios.length > 0,
        methods: medios,
        // Contra entrega siempre: es como paga la mayoría en Perú, y apagarlo
        // es una decisión del negocio que hoy no existe como ajuste.
        onDelivery: true,
      },
      welcome: bienvenida
        ? {
            code: bienvenida.code,
            label: describirCupon(bienvenida),
            minOrder:
              Number(bienvenida.min_order) > 0 ? bienvenida.min_order : null,
          }
        : null,
    };
  }

  /**
   * El archivo de verificación de Apple Pay para un host.
   *
   * Apple exige que **cada dominio** que enseñe su botón sirva un archivo suyo
   * en `/.well-known/apple-developer-merchantid-domain-association`. En una web
   * de un solo restaurante eso es subir un archivo; en un SaaS multimarca son
   * N archivos distintos servidos por el mismo proceso, y cuál toca depende del
   * host de quien pregunta — exactamente el mismo problema que resuelve el resto
   * de este módulo.
   *
   * Sin esto el botón de Apple Pay **no aparece y no hay ningún error**: Apple
   * comprueba el dominio por su cuenta, falla en silencio y el cliente
   * simplemente no ve la opción. Es la clase de fallo que cuesta una tarde de
   * mirar el código del checkout, que está bien.
   *
   * Devuelve `null` si ese dominio no tiene el archivo cargado, que es lo que
   * debe traducirse en un 404 y no en un archivo vacío: un archivo vacío le dice
   * a Apple que el dominio existe y está mal configurado.
   */
  async applePayVerification(host: string): Promise<string | null> {
    const normalizado = host.trim().toLowerCase().split(':')[0] ?? '';
    return withPublicToken(this.pool, async ({ client }) => {
      const { rows } = await client.query<{
        apple_pay_verification: string | null;
      }>(
        `SELECT apple_pay_verification FROM sto_domains
          WHERE lower(host) = $1 AND status = 'active' LIMIT 1`,
        [normalizado],
      );
      return rows[0]?.apple_pay_verification ?? null;
    });
  }

  /** Carga el archivo que Apple emite para un dominio del cliente. */
  async setApplePayVerification(
    tenantId: string,
    domainId: string,
    contenido: string,
    actorId?: string,
  ): Promise<void> {
    const limpio = contenido.trim();
    if (limpio.length > 0 && limpio.length < 32) {
      throw new ValidationError(
        'Ese no parece el archivo de Apple: pega su contenido completo, tal como lo descargaste.',
      );
    }
    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rowCount } = await ctx.client.query(
        `UPDATE sto_domains SET apple_pay_verification = $2 WHERE id = $1`,
        [domainId, limpio || null],
      );
      if (rowCount === 0) throw new NotFoundError('Ese dominio no existe.');
      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: 'storefront.apple_pay_configured',
        resourceType: 'storefront_domain',
        resourceId: domainId,
        data: { cargado: limpio.length > 0 },
      });
    });
  }

  // -------------------------------------------------------------- Aspecto

  /**
   * Cómo se ve la tienda de una marca (PA-12, referencia: Deliverect).
   *
   * Es un `upsert` por marca: no hay historial ni versiones. Cambiar un color no
   * es publicar una carta —eso sí se versiona, porque un precio pasado importa—;
   * es una preferencia que se ajusta mirando el resultado, y guardar cada
   * intento sería ruido.
   *
   * Un campo vacío BORRA el valor y devuelve la tienda al aspecto de Sahana. Sin
   * eso, quitar un logo mal subido exigiría otro botón: el único camino sería
   * poner encima otra imagen.
   */
  async setBranding(
    tenantId: string,
    input: {
      brandId: string;
      displayName?: string | undefined;
      tagline?: string | undefined;
      logoUrl?: string | undefined;
      coverUrl?: string | undefined;
      colorBase?: string | undefined;
      colorHover?: string | undefined;
      colorTexto?: string | undefined;
      actorId?: string | undefined;
    },
  ): Promise<Branding> {
    const valores = {
      displayName: input.displayName?.trim() || null,
      tagline: input.tagline?.trim() || null,
      logoUrl: imagenValida(input.logoUrl),
      coverUrl: imagenValida(input.coverUrl),
      colorBase: colorValido(input.colorBase),
      colorHover: colorValido(input.colorHover),
      colorTexto: colorValido(input.colorTexto),
    };

    return withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.client.query(
        `INSERT INTO sto_branding
           (tenant_id, brand_id, display_name, tagline, logo_url, cover_url,
            color_base, color_hover, color_texto, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (tenant_id, brand_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           tagline = EXCLUDED.tagline,
           logo_url = EXCLUDED.logo_url,
           cover_url = EXCLUDED.cover_url,
           color_base = EXCLUDED.color_base,
           color_hover = EXCLUDED.color_hover,
           color_texto = EXCLUDED.color_texto,
           updated_at = now()`,
        [
          tenantId,
          input.brandId,
          valores.displayName,
          valores.tagline,
          valores.logoUrl,
          valores.coverUrl,
          valores.colorBase,
          valores.colorHover,
          valores.colorTexto,
        ],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'storefront.branding_updated',
        resourceType: 'brand',
        resourceId: input.brandId,
        data: { ...valores },
      });

      return valores;
    });
  }

  /** El aspecto guardado de una marca, para la pantalla del panel. */
  async getBranding(tenantId: string, brandId: string): Promise<Branding> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        display_name: string | null;
        tagline: string | null;
        logo_url: string | null;
        cover_url: string | null;
        color_base: string | null;
        color_hover: string | null;
        color_texto: string | null;
      }>(
        `SELECT display_name, tagline, logo_url, cover_url,
                color_base, color_hover, color_texto
           FROM sto_branding WHERE brand_id = $1`,
        [brandId],
      );
      const r = rows[0];
      return {
        displayName: r?.display_name ?? null,
        tagline: r?.tagline ?? null,
        logoUrl: r?.logo_url ?? null,
        coverUrl: r?.cover_url ?? null,
        colorBase: r?.color_base ?? null,
        colorHover: r?.color_hover ?? null,
        colorTexto: r?.color_texto ?? null,
      };
    });
  }

  // ------------------------------------------------- Claves de integración

  /**
   * Emite una clave publicable para que un tercero monte su propia tienda.
   *
   * Se devuelve entera y se guarda en claro: **es pública por diseño** (ADR-0020),
   * va en el HTML de la web del cliente. Hashearla impediría enseñársela otra
   * vez en el panel —que es su único uso— sin proteger nada que no esté ya
   * publicado.
   */
  async issuePublishableKey(
    tenantId: string,
    input: {
      brandId: string;
      label?: string | undefined;
      actorId?: string | undefined;
    },
  ): Promise<{ id: string; key: string; label: string; brandId: string }> {
    const key = `pk_${randomBytes(16).toString('hex')}`;
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ id: string; label: string }>(
        `INSERT INTO sto_publishable_keys (tenant_id, brand_id, key, label)
         VALUES ($1,$2,$3,COALESCE($4,'Web del cliente'))
         RETURNING id, label`,
        [tenantId, input.brandId, key, input.label ?? null],
      );
      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'storefront.key_issued',
        resourceType: 'publishable_key',
        resourceId: rows[0]!.id,
        data: { brandId: input.brandId, label: rows[0]!.label },
      });
      return {
        id: rows[0]!.id,
        key,
        label: rows[0]!.label,
        brandId: input.brandId,
      };
    });
  }

  /**
   * Revoca una clave. No la borra.
   *
   * Una clave borrada deja de explicar por qué la web de un cliente dejó de
   * funcionar de golpe; una revocada, con su fecha, lo cuenta solo.
   */
  async revokePublishableKey(
    tenantId: string,
    id: string,
    actorId?: string,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rowCount } = await ctx.client.query(
        `UPDATE sto_publishable_keys SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL`,
        [id],
      );
      if (rowCount === 0) throw new NotFoundError('Esa clave no existe.');
      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: 'storefront.key_revoked',
        resourceType: 'publishable_key',
        resourceId: id,
        data: {},
      });
    });
  }

  async listPublishableKeys(tenantId: string): Promise<
    Array<{
      id: string;
      brandId: string;
      key: string;
      label: string;
      createdAt: string;
      revokedAt: string | null;
    }>
  > {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        brand_id: string;
        key: string;
        label: string;
        created_at: string;
        revoked_at: string | null;
      }>(
        `SELECT id, brand_id, key, label, created_at, revoked_at
           FROM sto_publishable_keys
          ORDER BY revoked_at IS NOT NULL, created_at DESC`,
      );
      return rows.map((r) => ({
        id: r.id,
        brandId: r.brand_id,
        key: r.key,
        label: r.label,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
      }));
    });
  }

  /**
   * Los orígenes a los que se permite llamar desde un navegador.
   *
   * Salen de los dominios que los clientes registraron y verificaron como
   * suyos: es la misma lista que decide qué host sirve qué marca, así que no
   * hay un segundo sitio que mantener. **Nunca `*`** — un comodín convierte el
   * catálogo y los precios de cada cliente en algo que cualquier web puede
   * montar en su página.
   *
   * Se incluyen `https://` y `http://` del mismo host porque un cliente prueba
   * en local antes de publicar, y no poder probar es la razón por la que la
   * gente acaba desactivando el CORS entero.
   */
  async allowedOrigins(): Promise<string[]> {
    const hosts = await withPublicToken(this.pool, async ({ client }) => {
      const { rows } = await client.query<{ host: string }>(
        `SELECT host FROM sto_domains WHERE status = 'active'`,
      );
      return rows.map((r) => r.host);
    });
    return hosts.flatMap((h) => [`https://${h}`, `http://${h}`]);
  }

  // ---------------------------------------------------------- Promociones

  /**
   * Las promociones del negocio, con lo que llevan usado.
   *
   * `usedCount` frente a `maxUses` es el dato que decide si una campaña sigue
   * viva, y no lo devolvía nada: un cupón limitado a cien usos se agotaba sin
   * que nadie se enterara hasta que un cliente se quejaba de que «no le
   * funciona el código».
   */
  async listCoupons(tenantId: string): Promise<CouponView[]> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        brand_id: string | null;
        code: string;
        kind: string;
        percent_bps: number | null;
        amount: string | null;
        min_order: string;
        max_uses: number | null;
        used_count: number;
        valid_until: string | null;
        active: boolean;
        is_welcome: boolean;
      }>(
        `SELECT id, brand_id, code, kind, percent_bps, amount, min_order,
                max_uses, used_count, valid_until, active, is_welcome
           FROM sto_coupons
          ORDER BY is_welcome DESC, active DESC, created_at DESC`,
      );
      return rows.map((r) => ({
        id: r.id,
        brandId: r.brand_id,
        code: r.code,
        kind: r.kind,
        percentBps: r.percent_bps,
        amount: r.amount,
        minOrder: r.min_order,
        maxUses: r.max_uses,
        usedCount: r.used_count,
        validUntil: r.valid_until,
        active: r.active,
        isWelcome: r.is_welcome,
        label: describirCupon(r),
      }));
    });
  }

  /**
   * Crea o actualiza una promoción.
   *
   * El código se normaliza a mayúsculas: quien lo teclea en el móvil escribe
   * «bienvenido» tanto como «BIENVENIDO», y dos cupones que solo se distinguen
   * por la caja son dos formas de que el cliente use el que no era.
   *
   * Marcar una como bienvenida DESMARCA la anterior de esa marca, en la misma
   * transacción. El índice único de la migración 0032 lo impediría de todas
   * formas, pero fallar con un error de base de datos obligaría al dueño a
   * acordarse de apagar la vieja: lo natural al activar la promoción de este
   * mes es que la del anterior deje de anunciarse.
   */
  async upsertCoupon(
    tenantId: string,
    input: {
      id?: string | undefined;
      brandId: string;
      code: string;
      kind: 'percent' | 'fixed' | 'free_delivery';
      percentBps?: number | undefined;
      amount?: string | undefined;
      minOrder?: string | undefined;
      maxUses?: number | undefined;
      validUntil?: string | undefined;
      active?: boolean | undefined;
      isWelcome?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<CouponView> {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,40}$/.test(code)) {
      throw new ValidationError(
        'El código va en letras y números, sin espacios ni acentos: se dicta por teléfono y se teclea en un móvil.',
      );
    }
    if (input.kind === 'percent') {
      const bps = input.percentBps ?? 0;
      if (!Number.isInteger(bps) || bps <= 0 || bps > 10000) {
        throw new ValidationError(
          'El porcentaje va en puntos básicos enteros, entre 1 y 10000 (1000 = 10 %).',
        );
      }
    }
    if (input.kind === 'fixed' && !input.amount) {
      throw new ValidationError('Un descuento fijo necesita su importe.');
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      // Al activar una bienvenida, la anterior de esa marca deja de serlo.
      if (input.isWelcome) {
        await ctx.client.query(
          `UPDATE sto_coupons SET is_welcome = false
            WHERE brand_id = $1 AND is_welcome AND ($2::uuid IS NULL OR id <> $2)`,
          [input.brandId, input.id ?? null],
        );
      }

      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO sto_coupons
           (id, tenant_id, brand_id, code, kind, percent_bps, amount, min_order,
            max_uses, valid_until, active, is_welcome)
         VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
                 COALESCE($8, 0), $9, $10, COALESCE($11, true), COALESCE($12, false))
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code,
           kind = EXCLUDED.kind,
           percent_bps = EXCLUDED.percent_bps,
           amount = EXCLUDED.amount,
           min_order = EXCLUDED.min_order,
           max_uses = EXCLUDED.max_uses,
           valid_until = EXCLUDED.valid_until,
           active = EXCLUDED.active,
           is_welcome = EXCLUDED.is_welcome
         RETURNING id`,
        [
          input.id ?? null,
          tenantId,
          input.brandId,
          code,
          input.kind,
          input.percentBps ?? null,
          input.amount ?? null,
          input.minOrder ?? null,
          input.maxUses ?? null,
          input.validUntil ?? null,
          input.active ?? null,
          input.isWelcome ?? null,
        ],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: input.id
          ? 'storefront.coupon_updated'
          : 'storefront.coupon_created',
        resourceType: 'coupon',
        resourceId: rows[0]!.id,
        data: {
          code,
          kind: input.kind,
          isWelcome: input.isWelcome ?? false,
          active: input.active ?? true,
        },
      });

      const { rows: leidas } = await ctx.client.query<{
        id: string;
        brand_id: string | null;
        code: string;
        kind: string;
        percent_bps: number | null;
        amount: string | null;
        min_order: string;
        max_uses: number | null;
        used_count: number;
        valid_until: string | null;
        active: boolean;
        is_welcome: boolean;
      }>(
        `SELECT id, brand_id, code, kind, percent_bps, amount, min_order,
                max_uses, used_count, valid_until, active, is_welcome
           FROM sto_coupons WHERE id = $1`,
        [rows[0]!.id],
      );
      const r = leidas[0]!;
      return {
        id: r.id,
        brandId: r.brand_id,
        code: r.code,
        kind: r.kind,
        percentBps: r.percent_bps,
        amount: r.amount,
        minOrder: r.min_order,
        maxUses: r.max_uses,
        usedCount: r.used_count,
        validUntil: r.valid_until,
        active: r.active,
        isWelcome: r.is_welcome,
        label: describirCupon(r),
      };
    });
  }

  /**
   * El catálogo que se enseña en la tienda. PÚBLICO: llega sin sesión.
   *
   * Sale del host, igual que todo lo demás aquí. Si la marca se pudiera pedir
   * por query string, cualquiera leería el catálogo y los precios de un
   * competidor desde su propio dominio.
   */
  async getPublicCatalog(host: string): Promise<ResolvedCatalog> {
    const { tenantId, brandId } = await this.tenantOfHost(host);
    return this.catalogoDeMarca(tenantId, brandId);
  }

  /**
   * De quién es esta petición pública: por CLAVE si la trae, si no por HOST.
   *
   * Vive aquí y no en el controlador porque es la regla que decide **qué marca
   * se sirve**, que es la más delicada de este módulo. Repartida entre la capa
   * HTTP y el servicio acabaría teniendo dos versiones, y una de ellas sería la
   * que un día resuelva mal.
   */
  private async resolverPeticion(input: {
    key?: string | undefined;
    host: string;
  }): Promise<{ tenantId: string; brandId: string }> {
    const clave = input.key?.trim();
    if (!clave) return this.tenantOfHost(input.host);

    const fila = await withPublicToken(this.pool, async ({ client }) => {
      const { rows } = await client.query<{
        tenant_id: string;
        brand_id: string;
      }>(
        `SELECT tenant_id, brand_id FROM sto_publishable_keys
          WHERE key = $1 AND revoked_at IS NULL LIMIT 1`,
        [clave],
      );
      return rows[0];
    });
    if (!fila) throw new NotFoundError('Esa clave de tienda no es válida.');
    return { tenantId: fila.tenant_id, brandId: fila.brand_id };
  }

  /** El contexto de la tienda, por clave o por host (ADR-0020). */
  async resolveStorefront(input: {
    key?: string | undefined;
    host: string;
  }): Promise<StorefrontContext> {
    const { tenantId, brandId } = await this.resolverPeticion(input);
    const host = await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ host: string }>(
        `SELECT host FROM sto_domains
          WHERE brand_id = $1 AND status = 'active'
          ORDER BY is_subdomain ASC LIMIT 1`,
        [brandId],
      );
      return rows[0]?.host ?? '';
    });
    return this.contextoDeMarca(tenantId, brandId, host);
  }

  /** El catálogo público, por clave o por host. */
  async getPublicCatalogFor(input: {
    key?: string | undefined;
    host: string;
  }): Promise<ResolvedCatalog> {
    const { tenantId, brandId } = await this.resolverPeticion(input);
    return this.catalogoDeMarca(tenantId, brandId);
  }

  /** Abre un carrito, por clave o por host. */
  async createCartFor(input: {
    key?: string | undefined;
    host: string;
  }): Promise<{ token: string; url: string | null }> {
    const { tenantId, brandId } = await this.resolverPeticion(input);
    return this.createCartForBrand(tenantId, brandId);
  }

  /** El tenant del host, para uso interno del propio módulo. */
  private async tenantOfHost(
    host: string,
  ): Promise<{ tenantId: string; brandId: string }> {
    const normalizado = host.trim().toLowerCase().split(':')[0] ?? '';
    const fila = await withPublicToken(this.pool, async ({ client }) => {
      const { rows } = await client.query<{
        tenant_id: string;
        brand_id: string;
      }>(
        `SELECT tenant_id, brand_id FROM sto_domains
          WHERE lower(host) = $1 AND status = 'active' LIMIT 1`,
        [normalizado],
      );
      return rows[0];
    });
    if (!fila)
      throw new NotFoundError('No hay ninguna tienda en este dominio.');
    return { tenantId: fila.tenant_id, brandId: fila.brand_id };
  }

  // -------------------------------------------------------------- Carrito

  /** Abre un carrito para el host. Devuelve su token público. */
  async createCart(host: string): Promise<{ token: string }> {
    const { tenantId, brandId } = await this.tenantOfHost(host);
    return this.createCartForBrand(tenantId, brandId);
  }

  /**
   * Abre un carrito para una marca, sin pasar por el host.
   *
   * Lo usa el agente de IA para mandarle un enlace al cliente por WhatsApp
   * (spec 19 §3). El host sigue siendo el camino del navegador; aquí el tenant
   * ya está resuelto por el token de la conversación, así que exigir un host
   * sería obligar a un módulo interno a adivinar el dominio de su propio
   * cliente.
   *
   * Devuelve también la URL pública cuando la marca tiene dominio verificado:
   * un token suelto no se puede mandar por chat, y construir la URL en el
   * módulo que llame acabaría con dos formas distintas del mismo enlace.
   */
  async createCartForBrand(
    tenantId: string,
    brandId: string,
  ): Promise<{ token: string; url: string | null }> {
    const expiresAt = new Date(Date.now() + CART_TTL_HOURS * 3_600_000);

    const { token } = await withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO sto_carts (tenant_id, brand_id, expires_at)
         VALUES ($1,$2,$3) RETURNING id`,
        [tenantId, brandId, expiresAt],
      );
      const token = await this.publicTokens.issue(ctx, {
        purpose: 'cart',
        resourceType: 'cart',
        resourceId: rows[0]!.id,
        expiresAt,
      });
      return { token };
    });

    const host = await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ host: string }>(
        `SELECT host FROM sto_domains
          WHERE brand_id = $1 AND status = 'active'
          ORDER BY created_at LIMIT 1`,
        [brandId],
      );
      return rows[0]?.host ?? null;
    });

    return { token, url: host ? `https://${host}/carrito/${token}` : null };
  }

  /**
   * Añade una línea. **Valida aquí** (RN-STO-02, primera mitad).
   *
   * Rechazar el producto agotado en este momento es lo que evita que el cliente
   * llegue al checkout con algo que no puede comprar. La segunda mitad —volver
   * a validar al confirmar— existe porque entre agregar y pagar pasan minutos.
   *
   * Se valida contra el CATÁLOGO RESUELTO, no contra un SELECT propio: la
   * resolución de precio, pausa y canal ya vive en Catalog + `@sahana/domain`, y
   * una segunda copia aquí se desincroniza el día que cambie una regla. Que el
   * catálogo esté resuelto por marca es además lo que impide meter en el
   * carrito de una marca un plato de la otra marca de la misma cocina.
   */
  async addLine(
    token: string,
    input: {
      productId: string;
      quantity: number;
      modifierOptionIds?: string[] | undefined;
      notes?: string | undefined;
    },
  ): Promise<CartView> {
    const { tenantId, cartId, brandId } = await this.resolveCart(token);
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new ValidationError(
        'La cantidad tiene que ser un entero positivo.',
      );
    }
    if (input.quantity > MAX_CANTIDAD_LINEA) {
      throw new ValidationError(
        `Como máximo ${MAX_CANTIDAD_LINEA} unidades por producto. Para un pedido mayor, llámanos.`,
      );
    }

    const catalogo = await this.catalogoDeMarca(tenantId, brandId);
    const producto = catalogo.products.find((p) => p.id === input.productId);
    if (!producto) {
      throw new ValidationError('Ese producto ya no está disponible.', {
        code: 'PRODUCT_UNAVAILABLE',
      });
    }

    // Los modificadores se validan AQUÍ y con la misma función que usa el
    // pedido. Sin esto, un carrito al que le falta el grupo obligatorio
    // «Tamaño» se construye tranquilamente y revienta en el checkout, con el
    // cliente ya con la tarjeta en la mano: el peor momento posible para
    // enterarse de que faltaba elegir algo.
    this.validarModificadores(producto, input.modifierOptionIds ?? []);

    await withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.client.query(
        `INSERT INTO sto_cart_lines
           (tenant_id, cart_id, product_id, quantity, modifier_option_ids, notes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          tenantId,
          cartId,
          input.productId,
          input.quantity,
          input.modifierOptionIds ?? [],
          input.notes ?? null,
        ],
      );
      await ctx.client.query(
        'UPDATE sto_carts SET updated_at = now() WHERE id = $1',
        [cartId],
      );
    });

    return this.getCart(token);
  }

  async removeLine(token: string, lineId: string): Promise<CartView> {
    const { tenantId, cartId } = await this.resolveCart(token);
    await withTenant(this.pool, tenantId, ({ client }) =>
      client.query(
        'DELETE FROM sto_cart_lines WHERE id = $1 AND cart_id = $2',
        [lineId, cartId],
      ),
    );
    return this.getCart(token);
  }

  /**
   * Cambia la CANTIDAD de una línea ya puesta.
   *
   * Sin esto, «quiero dos» obliga a añadir el producto otra vez —y `addLine`
   * siempre inserta, así que salen dos líneas de uno en vez de una de dos— o a
   * quitarlo y empezar de nuevo eligiendo otra vez todos los modificadores.
   * Es la operación que más se usa en un carrito y era la única que faltaba.
   *
   * Bajar a cero BORRA la línea en lugar de guardar una de cantidad cero: un
   * carrito con «0 × Pollo» dentro no es un carrito, es un error de contabilidad
   * esperando a que alguien lo sume.
   *
   * El importe no se toca aquí. Se vuelve a leer el carrito entero, que lo
   * recalcula en el servidor con `@sahana/domain`: la cantidad es lo único que
   * viaja desde el navegador.
   */
  async setLineQuantity(
    token: string,
    lineId: string,
    quantity: number,
  ): Promise<CartView> {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new ValidationError('La cantidad tiene que ser un entero.');
    }
    if (quantity > MAX_CANTIDAD_LINEA) {
      throw new ValidationError(
        `Como máximo ${MAX_CANTIDAD_LINEA} unidades por producto. Para un pedido mayor, llámanos.`,
      );
    }
    if (quantity === 0) return this.removeLine(token, lineId);

    const { tenantId, cartId } = await this.resolveCart(token);
    await withTenant(this.pool, tenantId, ({ client }) =>
      client.query(
        'UPDATE sto_cart_lines SET quantity = $3 WHERE id = $1 AND cart_id = $2',
        [lineId, cartId, quantity],
      ),
    );
    return this.getCart(token);
  }

  /**
   * Fija la dirección y resuelve el LOCAL por su zona (RN-STO-01).
   *
   * Sin cobertura no se devuelve un error: se devuelve un carrito en modo
   * `pickup` con el motivo. «No llegamos a tu dirección, pero puedes recoger»
   * conserva la venta; «error de cobertura» la pierde.
   */
  async setAddress(
    token: string,
    input: { address: string; lat: number; lng: number },
  ): Promise<CartView> {
    const { tenantId, cartId, brandId } = await this.resolveCart(token);

    // `findCoverage` recibe `Position = [lng, lat]`, en ese orden — es el de
    // GeoJSON, no el de «latitud y longitud» que dice la gente. Invertirlo
    // coloca Lima en el océano Índico y la tienda responde «sin cobertura» a
    // todo el mundo.
    const zona = await this.organization.findCoverage(
      tenantId,
      [input.lng, input.lat],
      brandId,
    );

    await withTenant(this.pool, tenantId, ({ client }) =>
      client.query(
        `UPDATE sto_carts
            SET address = $2, address_lat = $3, address_lng = $4,
                zone_id = $5, location_id = $6,
                fulfillment = CASE WHEN $5::uuid IS NULL THEN 'pickup' ELSE 'delivery' END,
                updated_at = now()
          WHERE id = $1`,
        [
          cartId,
          input.address,
          input.lat,
          input.lng,
          zona?.zoneId ?? null,
          zona?.locationId ?? null,
        ],
      ),
    );

    return this.getCart(token);
  }

  /** Datos del invitado y consentimiento SEPARADO (RN-STO-04, RN-T10). */
  async setCustomer(
    token: string,
    input: {
      name: string;
      phone: string;
      notes?: string | undefined;
      marketingConsent?: boolean | undefined;
      marketingConsentText?: string | undefined;
    },
  ): Promise<CartView> {
    const { tenantId, cartId } = await this.resolveCart(token);

    if (input.marketingConsent && !input.marketingConsentText) {
      // Un booleano no demuestra qué aceptó nadie. La ley 29733 pide poder
      // acreditar el consentimiento, y para eso hace falta el texto exacto.
      throw new ValidationError(
        'Para registrar el consentimiento de marketing hace falta el texto exacto que se aceptó.',
      );
    }

    await withTenant(this.pool, tenantId, ({ client }) =>
      client.query(
        `UPDATE sto_carts
            SET customer_name = $2, customer_phone = $3, notes = $4,
                marketing_consent = $5, marketing_consent_text = $6,
                marketing_consent_at = CASE WHEN $5 THEN now() ELSE NULL END,
                updated_at = now()
          WHERE id = $1`,
        [
          cartId,
          input.name,
          input.phone,
          input.notes ?? null,
          input.marketingConsent ?? false,
          input.marketingConsentText ?? null,
        ],
      ),
    );

    return this.getCart(token);
  }

  async applyCouponCode(token: string, code: string): Promise<CartView> {
    const { tenantId, cartId } = await this.resolveCart(token);
    await withTenant(this.pool, tenantId, ({ client }) =>
      client.query('UPDATE sto_carts SET coupon_code = $2 WHERE id = $1', [
        cartId,
        code.trim().toUpperCase(),
      ]),
    );
    return this.getCart(token);
  }

  /**
   * Estado completo del carrito, con precios FRESCOS del catálogo.
   *
   * Las líneas de un producto agotado se marcan `unavailable` en vez de
   * borrarse. Borrarlas en silencio haría desaparecer cosas del carrito sin que
   * el cliente entienda por qué, que se siente como un fallo de la tienda.
   */
  async getCart(token: string): Promise<CartView> {
    const { tenantId, cartId, brandId } = await this.resolveCart(token);
    const catalogo = await this.catalogoDeMarca(tenantId, brandId);
    const porId = new Map(catalogo.products.map((p) => [p.id, p]));

    return withTenant(this.pool, tenantId, async (ctx) => {
      const cabecera = await this.loadCart(ctx, cartId);
      const lineas = await this.loadLines(ctx, cartId);

      const bloqueos: CartView['blockers'] = [];
      let subtotal = Money.zero();

      const vistas: CartLineView[] = [];
      for (const linea of lineas) {
        // Ausente del catálogo resuelto = agotado, pausado, sin precio en web o
        // de otra marca. Los cuatro significan lo mismo para quien compra: hoy
        // no se puede pedir.
        const producto = porId.get(linea.product_id);
        const precio = producto
          ? Money.fromMinor(producto.price.minorUnits, producto.price.currency)
          : Money.zero();
        const modificadores = producto
          ? this.precioModificadores(producto, linea.modifier_option_ids ?? [])
          : Money.zero();
        const unitario = precio.add(modificadores);
        const total = Money.fromMinor(unitario.minorUnits * linea.quantity);

        if (!producto) {
          bloqueos.push({
            code: 'PRODUCT_UNAVAILABLE',
            // Con el NOMBRE, no con el id: el cliente tiene que poder quitarlo.
            detail: `"${linea.name ?? 'Un producto'}" ya no está disponible.`,
          });
        } else {
          subtotal = subtotal.add(total);
        }

        vistas.push({
          id: linea.id,
          productId: linea.product_id,
          name: producto?.name ?? linea.name ?? 'Producto retirado',
          quantity: linea.quantity,
          unitPrice: unitario.toDecimalString(),
          lineTotal: total.toDecimalString(),
          unavailable: !producto,
        });
      }

      const envio =
        cabecera.fulfillment === 'delivery' && cabecera.zone_id
          ? await this.tarifaDeZona(ctx, cabecera.zone_id)
          : Money.zero();

      let descuento = Money.zero();
      let cupon: CartView['coupon'] = null;
      if (cabecera.coupon_code) {
        const resultado = await this.evaluarCupon(
          ctx,
          cabecera.coupon_code,
          subtotal,
          envio,
        );
        cupon = resultado.vista;
        descuento = resultado.descuento;
      }

      if (vistas.length === 0) {
        bloqueos.push({ code: 'CART_EMPTY', detail: 'El carrito está vacío.' });
      }
      if (cabecera.fulfillment === 'delivery' && !cabecera.location_id) {
        bloqueos.push({
          code: 'NO_ADDRESS',
          detail: 'Falta una dirección con cobertura.',
        });
      }
      if (!cabecera.customer_phone) {
        bloqueos.push({
          code: 'NO_CUSTOMER',
          detail: 'Faltan los datos de contacto.',
        });
      }

      const total = Money.fromMinor(
        Math.max(
          0,
          subtotal.minorUnits + envio.minorUnits - descuento.minorUnits,
        ),
      );

      return {
        token,
        status: cabecera.status,
        fulfillment: cabecera.fulfillment,
        lines: vistas,
        subtotal: subtotal.toDecimalString(),
        deliveryFee: envio.toDecimalString(),
        discount: descuento.toDecimalString(),
        total: total.toDecimalString(),
        currency: 'PEN',
        coupon: cupon,
        blockers: bloqueos,
      };
    });
  }

  /**
   * Convierte el carrito en pedido. **Vuelve a validar** (RN-STO-02, segunda
   * mitad).
   *
   * Entre agregar y pagar pasan minutos, y en una cocina eso es tiempo de sobra
   * para que se acabe el pollo. Revalidar aquí es lo que impide cobrar por algo
   * que no se puede entregar.
   */
  async checkout(
    token: string,
    options: { payment?: 'online' | 'on_delivery' | undefined } = {},
  ): Promise<CheckoutResult> {
    const vista = await this.getCart(token);
    if (vista.blockers.length > 0) {
      throw new ValidationError(vista.blockers.map((b) => b.detail).join(' '), {
        blockers: vista.blockers,
      });
    }

    const { tenantId, cartId, brandId } = await this.resolveCart(token);
    const catalogo = await this.catalogoDeMarca(tenantId, brandId);
    const vigentes = new Set(catalogo.products.map((p) => p.id));

    const pedido = await withTenant(this.pool, tenantId, async (ctx) => {
      const cabecera = await this.loadCart(ctx, cartId);
      if (cabecera.status !== 'open') {
        throw new ValidationError('Este carrito ya se convirtió en pedido.');
      }
      const lineas = await this.loadLines(ctx, cartId);

      // La SEGUNDA validación. Sí, se acaba de hacer en `getCart`: se repite
      // dentro de la transacción del pedido porque entre una y otra caben
      // milisegundos, y en esos milisegundos alguien puede pausar un producto.
      for (const linea of lineas) {
        if (!vigentes.has(linea.product_id)) {
          throw new ValidationError(
            `"${linea.name ?? 'Un producto'}" se agotó mientras terminabas el pedido.`,
            { code: 'PRODUCT_UNAVAILABLE', productId: linea.product_id },
          );
        }
      }

      return { cabecera, lineas };
    });

    // Recojo: no hay zona, así que tampoco local resuelto por cobertura. El
    // pedido igual tiene que producirse en algún sitio, y ese sitio es la
    // cocina de la marca. Sin esto, «recoger» acaba en un pedido sin local que
    // el motor rechaza — justo la venta que el modo recojo venía a salvar.
    const locationId =
      pedido.cabecera.location_id ??
      (await this.localDeRecojo(tenantId, brandId));

    const creado = await this.ordering.submit(tenantId, {
      brandId,
      locationId,
      channel: 'web',
      lines: pedido.lineas.map((l) => ({
        productId: l.product_id,
        quantity: l.quantity,
        modifierOptionIds: l.modifier_option_ids ?? [],
        ...(l.notes ? { notes: l.notes } : {}),
      })),
      ...(pedido.cabecera.customer_name
        ? { customerName: pedido.cabecera.customer_name }
        : {}),
      ...(pedido.cabecera.customer_phone
        ? { customerPhone: pedido.cabecera.customer_phone }
        : {}),
    });

    await withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.client.query(
        `UPDATE sto_carts SET status = 'ordered', order_id = $2, updated_at = now()
          WHERE id = $1`,
        [cartId, creado.id],
      );
      // El contador del cupón se incrementa EN LA MISMA transacción que la
      // conversión: uno que se actualiza después deja pasar cien usos de un
      // cupón de uno.
      if (pedido.cabecera.coupon_code) {
        await ctx.client.query(
          'UPDATE sto_coupons SET used_count = used_count + 1 WHERE upper(code) = $1',
          [pedido.cabecera.coupon_code],
        );
      }
    });

    // Pago EN LÍNEA: la intención se crea aquí, no en un endpoint aparte que
    // el comprador tendría que acertar a llamar. Sin esto el checkout dejaba
    // un pedido sin forma de pagarlo: `POST /payments/intents` exige
    // `payments.charge`, que es un permiso de personal — un invitado no lo
    // tiene y no debe tenerlo.
    //
    // Se hace DESPUÉS de crear el pedido a propósito: la intención referencia
    // un pedido, y una intención sin pedido detrás es dinero cobrado que nadie
    // sabe a qué imputar.
    if (options.payment === 'online') {
      const intento = await this.payments.createIntent(tenantId, {
        orderId: creado.id,
        provider: await this.pasarelaDeLaMarca(tenantId, brandId),
      });
      return {
        orderId: creado.id,
        total: vista.total,
        payment: {
          reference: intento.reference,
          checkoutUrl: intento.checkoutUrl,
          expiresAt: intento.expiresAt,
        },
      };
    }

    return { orderId: creado.id, total: vista.total };
  }

  /**
   * Qué pasarela usa esta marca.
   *
   * La elige el NEGOCIO, no el comprador: dejar que el cliente mande el nombre
   * del proveedor convierte un parámetro público en la forma de apuntar el
   * cobro a una conexión que no es la suya.
   */
  private async pasarelaDeLaMarca(
    tenantId: string,
    brandId: string,
  ): Promise<string> {
    const fila = await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ provider: string }>(
        `SELECT provider FROM pay_connections
          WHERE status = 'active' AND (brand_id IS NULL OR brand_id = $1)
          ORDER BY brand_id NULLS LAST
          LIMIT 1`,
        [brandId],
      );
      return rows[0];
    });
    if (!fila) {
      // Mensaje para el COMPRADOR: no es culpa suya y no puede arreglarlo.
      throw new ValidationError(
        'Esta tienda no tiene pago en línea disponible ahora mismo. Puedes pedir con pago contra entrega.',
        { code: 'ONLINE_PAYMENT_UNAVAILABLE' },
      );
    }
    return fila.provider;
  }

  // ---------------------------------------------------------------- Apoyo

  private async resolveCart(
    token: string,
  ): Promise<{ tenantId: string; cartId: string; brandId: string }> {
    const resuelto = await this.publicTokens.resolve(token, 'cart');
    const fila = await withTenant(
      this.pool,
      resuelto.tenantId,
      async ({ client }) => {
        const { rows } = await client.query<{ brand_id: string }>(
          'SELECT brand_id FROM sto_carts WHERE id = $1',
          [resuelto.resourceId],
        );
        return rows[0];
      },
    );
    if (!fila) throw new PublicTokenError();
    return {
      tenantId: resuelto.tenantId,
      cartId: resuelto.resourceId,
      brandId: fila.brand_id,
    };
  }

  private async loadCart(
    ctx: TenantContext,
    cartId: string,
  ): Promise<{
    status: string;
    fulfillment: string;
    location_id: string | null;
    zone_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    coupon_code: string | null;
  }> {
    const { rows } = await ctx.client.query<{
      status: string;
      fulfillment: string;
      location_id: string | null;
      zone_id: string | null;
      customer_name: string | null;
      customer_phone: string | null;
      coupon_code: string | null;
    }>(
      `SELECT status, fulfillment, location_id, zone_id,
              customer_name, customer_phone, coupon_code
         FROM sto_carts WHERE id = $1`,
      [cartId],
    );
    const fila = rows[0];
    if (!fila) throw new PublicTokenError();
    return fila;
  }

  /**
   * Las líneas TAL COMO se guardaron. Sin precio: el precio no se guarda nunca
   * en el carrito, se resuelve del catálogo en cada consulta. `name` es solo un
   * rótulo de respaldo para poder nombrar un producto que ya desapareció del
   * catálogo y que el cliente tiene que poder quitar.
   */
  private async loadLines(
    ctx: TenantContext,
    cartId: string,
  ): Promise<
    Array<{
      id: string;
      product_id: string;
      quantity: number;
      modifier_option_ids: string[];
      notes: string | null;
      name: string | null;
    }>
  > {
    const { rows } = await ctx.client.query<{
      id: string;
      product_id: string;
      quantity: number;
      modifier_option_ids: string[];
      notes: string | null;
      name: string | null;
    }>(
      `SELECT l.id, l.product_id, l.quantity, l.modifier_option_ids, l.notes,
              p.name
         FROM sto_cart_lines l
         LEFT JOIN cat_products p ON p.id = l.product_id
        WHERE l.cart_id = $1
        ORDER BY l.created_at`,
      [cartId],
    );
    return rows;
  }

  /**
   * Catálogo resuelto de la marca para el canal `web`.
   *
   * Único sitio del módulo que decide qué se puede vender y a qué precio. Que
   * sea uno solo es el punto: precio por canal, pausas y visibilidad ya están
   * resueltos en Catalog + `@sahana/domain`, y una segunda implementación aquí
   * haría que la tienda cobrara distinto que la caja el día que cambie una regla.
   */
  private async catalogoDeMarca(
    tenantId: string,
    brandId: string,
  ): Promise<ResolvedCatalog> {
    return this.catalog.getResolvedCatalog(tenantId, {
      brandId,
      channel: 'web',
    });
  }

  /**
   * Valida la selección de modificadores con la MISMA función que el pedido.
   *
   * Las opciones llegan planas —el cliente marca casillas, no piensa en
   * grupos—, así que hay que reagruparlas antes de validar. Un id que no
   * pertenece a ningún grupo del producto se rechaza en vez de ignorarse: si se
   * ignorara, un cliente podría colar la opción de otro plato y salir con un
   * precio que no existe.
   */
  private validarModificadores(
    producto: ResolvedProduct,
    optionIds: readonly string[],
  ): void {
    const grupoDeOpcion = new Map<string, string>();
    for (const grupo of producto.modifierGroups) {
      for (const opcion of grupo.options)
        grupoDeOpcion.set(opcion.id, grupo.id);
    }

    const porGrupo = new Map<string, string[]>();
    for (const id of optionIds) {
      const grupoId = grupoDeOpcion.get(id);
      if (!grupoId) {
        throw new ValidationError(
          'Una de las opciones elegidas no pertenece a este producto.',
          { code: 'MODIFIER_OPTION_UNKNOWN', optionId: id },
        );
      }
      porGrupo.set(grupoId, [...(porGrupo.get(grupoId) ?? []), id]);
    }

    // Los grupos obligatorios sin elegir tienen que llegar a la validación como
    // selección vacía; si no se enviaran, `validateAndPriceModifiers` no vería
    // que falta nada y el fallo aparecería en el checkout.
    const selecciones: ModifierSelection[] = producto.modifierGroups.map(
      (g) => ({
        groupId: g.id,
        optionIds: porGrupo.get(g.id) ?? [],
      }),
    );

    try {
      validateAndPriceModifiers(producto.modifierGroups, selecciones);
    } catch (error) {
      if (error instanceof ModifierError) {
        throw new ValidationError(error.message, { code: error.code });
      }
      throw error;
    }
  }

  /** Ajuste de precio de los modificadores ya elegidos. Nunca recalcula reglas. */
  private precioModificadores(
    producto: ResolvedProduct,
    optionIds: readonly string[],
  ): Money {
    const elegidas = new Set(optionIds);
    let delta = Money.zero();
    for (const grupo of producto.modifierGroups) {
      for (const opcion of grupo.options) {
        if (elegidas.has(opcion.id)) {
          delta = delta.add(Money.fromMinor(opcion.priceDeltaMinor));
        }
      }
    }
    return delta;
  }

  /** El local donde se recoge: la cocina que produce la marca. */
  private async localDeRecojo(
    tenantId: string,
    brandId: string,
  ): Promise<string> {
    const cocinas = await this.organization.kitchensForBrand(tenantId, brandId);
    const local = cocinas[0]?.locationId;
    if (!local) {
      throw new ValidationError(
        'Esta marca no tiene ninguna cocina activa donde recoger.',
        { code: 'PICKUP_NO_LOCATION' },
      );
    }
    return local;
  }

  private async tarifaDeZona(
    ctx: TenantContext,
    zoneId: string,
  ): Promise<Money> {
    const { rows } = await ctx.client.query<{ delivery_fee: string }>(
      'SELECT delivery_fee FROM org_zones WHERE id = $1',
      [zoneId],
    );
    return rows[0] ? Money.parse(rows[0].delivery_fee) : Money.zero();
  }

  private async evaluarCupon(
    ctx: TenantContext,
    code: string,
    subtotal: Money,
    envio: Money,
  ): Promise<{ vista: CartView['coupon']; descuento: Money }> {
    const { rows } = await ctx.client.query<{
      code: string;
      kind: string;
      percent_bps: number | null;
      amount: string | null;
      min_order: string;
      max_discount: string | null;
      valid_from: Date | null;
      valid_until: Date | null;
      max_uses: number | null;
      used_count: number;
      active: boolean;
    }>(
      `SELECT code, kind, percent_bps, amount, min_order, max_discount,
              valid_from, valid_until, max_uses, used_count, active
         FROM sto_coupons WHERE upper(code) = $1`,
      [code],
    );
    const fila = rows[0];
    if (!fila) {
      return {
        vista: { code, applied: false, reason: 'COUPON_UNKNOWN' },
        descuento: Money.zero(),
      };
    }

    const cupon: Coupon = {
      code: fila.code,
      kind: fila.kind as Coupon['kind'],
      percentBps: fila.percent_bps ?? undefined,
      amountMinor: fila.amount
        ? Money.parse(fila.amount).minorUnits
        : undefined,
      minOrderMinor: Money.parse(fila.min_order).minorUnits,
      maxDiscountMinor: fila.max_discount
        ? Money.parse(fila.max_discount).minorUnits
        : undefined,
      validFrom: fila.valid_from ?? undefined,
      validUntil: fila.valid_until ?? undefined,
      maxUses: fila.max_uses ?? undefined,
      usedCount: fila.used_count,
      active: fila.active,
    };

    const resultado = applyCoupon(cupon, subtotal, envio);
    if (!resultado.applies) {
      return {
        vista: {
          code: fila.code,
          applied: false,
          reason: (resultado.rejection as CouponRejection).code,
        },
        descuento: Money.zero(),
      };
    }
    return {
      vista: { code: fila.code, applied: true },
      descuento: resultado.discount,
    };
  }
}
