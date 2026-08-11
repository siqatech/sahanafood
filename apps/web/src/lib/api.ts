import { headers } from 'next/headers';

/**
 * Cliente de la API para la tienda (spec 11).
 *
 * Regla que ordena todo este archivo: **el `Host` del visitante viaja SIEMPRE a
 * la API**, y es lo único que decide qué marca se sirve. La tienda no conoce el
 * `tenantId` ni el `brandId`; los recibe. Si algún día alguien añadiera aquí un
 * parámetro de marca «para probar», la tienda de cada cliente pasaría a ser un
 * buscador de catálogos ajenos.
 */

const API_URL = process.env['SAHANA_API_URL'] ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ProblemDetails | null,
  ) {
    super(body?.detail ?? `La tienda no respondió (${status}).`);
  }
}

/** Problem Details (RFC 9457) tal como los devuelve la API. */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  blockers?: Array<{ code: string; detail: string }>;
}

export interface ShopContext {
  brandId: string;
  brandName: string;
  host: string;
  /**
   * La oferta de bienvenida, ya redactada por el servidor.
   *
   * El texto viene hecho a propósito: describe un descuento, y componerlo aquí
   * sería duplicar en el navegador una regla de precios que vive en el
   * servidor. `null` cuando no hay ninguna activa, o cuando caducó o se agotó.
   */
  welcome: { code: string; label: string; minOrder: string | null } | null;
  /** Aspecto de la tienda. Los nulos significan «usa lo de Sahana». */
  branding: {
    displayName: string | null;
    tagline: string | null;
    logoUrl: string | null;
    coverUrl: string | null;
    colorBase: string | null;
    colorHover: string | null;
    colorTexto: string | null;
  };
}

export interface CatalogProduct {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  imageUrl: string | null;
  price: { minorUnits: number; currency: string; scale: number };
  modifierGroups: Array<{
    id: string;
    name: string;
    minSelections: number;
    maxSelections: number;
    options: Array<{
      id: string;
      name: string;
      priceDeltaMinor: number;
      available: boolean;
    }>;
  }>;
}

export interface Catalog {
  brandId: string;
  channel: string;
  categories: Array<{ id: string; name: string; sortOrder: number }>;
  products: CatalogProduct[];
}

export interface CartLine {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  unavailable: boolean;
}

export interface Cart {
  token: string;
  status: string;
  fulfillment: string;
  lines: CartLine[];
  subtotal: string;
  deliveryFee: string;
  discount: string;
  total: string;
  currency: string;
  coupon: { code: string; applied: boolean; reason?: string } | null;
  blockers: Array<{ code: string; detail: string }>;
}

/**
 * El host del visitante, tal como llegó.
 *
 * En producción detrás de un proxy, el host real viene en `x-forwarded-host`.
 * Si se leyera solo `host`, todas las tiendas resolverían al host interno del
 * balanceador y **todos los clientes verían la misma marca** — el fallo más
 * caro posible en un SaaS multi-marca, y silencioso: la página carga.
 */
async function visitorHost(): Promise<string> {
  const h = await headers();
  return h.get('x-forwarded-host') ?? h.get('host') ?? '';
}

async function call<T>(
  path: string,
  init: RequestInit & { method?: string } = {},
): Promise<T> {
  const host = await visitorHost();
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      // El host del visitante va en `x-forwarded-host`, NO en `host`.
      //
      // `host` es una cabecera prohibida para `fetch`: undici la **descarta en
      // silencio** y la pone al destino real. Costó encontrarlo porque no falla
      // — la API recibe `localhost:3000`, no encuentra tienda, y la página
      // responde 200 con «no hay ninguna tienda en este dominio». Verde por
      // fuera y roto por dentro.
      //
      // `x-forwarded-host` es además lo que pondría el proxy en producción, así
      // que la API lee lo mismo en los dos casos.
      'x-forwarded-host': host,
      ...(init.headers ?? {}),
    },
    // El catálogo y el carrito cambian con el stock: una respuesta cacheada
    // enseña un producto agotado como disponible, que es justo lo que
    // RN-STO-02 existe para evitar.
    cache: 'no-store',
  });

  if (!res.ok) {
    let body: ProblemDetails | null = null;
    try {
      body = (await res.json()) as ProblemDetails;
    } catch {
      body = null;
    }
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export const shop = {
  context: (): Promise<ShopContext> => call<ShopContext>('/shop/context'),
  catalog: (): Promise<Catalog> => call<Catalog>('/shop/catalog'),
  createCart: (): Promise<{ token: string }> =>
    call<{ token: string }>('/shop/carts', { method: 'POST' }),
  getCart: (token: string): Promise<Cart> => call<Cart>(`/shop/carts/${token}`),
  addLine: (
    token: string,
    input: {
      productId: string;
      quantity: number;
      modifierOptionIds?: string[];
    },
  ): Promise<Cart> =>
    call<Cart>(`/shop/carts/${token}/lines`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  removeLine: (token: string, lineId: string): Promise<Cart> =>
    call<Cart>(`/shop/carts/${token}/lines/${lineId}`, { method: 'DELETE' }),
  /** Cambia la cantidad de una línea. `0` la quita. */
  setLineQuantity: (
    token: string,
    lineId: string,
    quantity: number,
  ): Promise<Cart> =>
    call<Cart>(`/shop/carts/${token}/lines/${lineId}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity }),
    }),
  setAddress: (
    token: string,
    input: { address: string; lat: number; lng: number },
  ): Promise<Cart> =>
    call<Cart>(`/shop/carts/${token}/address`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setCustomer: (
    token: string,
    input: {
      name: string;
      phone: string;
      notes?: string;
      marketingConsent?: boolean;
      marketingConsentText?: string;
    },
  ): Promise<Cart> =>
    call<Cart>(`/shop/carts/${token}/customer`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  applyCoupon: (token: string, code: string): Promise<Cart> =>
    call<Cart>(`/shop/carts/${token}/coupon`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  checkout: (token: string): Promise<{ orderId: string; total: string }> =>
    call<{ orderId: string; total: string }>(`/shop/carts/${token}/checkout`, {
      method: 'POST',
    }),
};
