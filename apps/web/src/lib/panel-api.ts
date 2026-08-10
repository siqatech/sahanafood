import { tokenDeAcceso } from './panel-session';

/**
 * Cliente de la API para el PANEL (specs/ux/03).
 *
 * La diferencia con `lib/api.ts` no es cosmética y conviene tenerla clara:
 *
 *  · La **tienda** no tiene sesión y su tenant sale del `Host`. Aquí es al
 *    revés: hay sesión, y **el tenant sale del token**, jamás de la URL ni de
 *    un campo del formulario. Por eso ninguna función de este archivo acepta
 *    un `tenantId`: no habría dónde ponerlo.
 *  · La tienda cachea poco; el panel, nada. Un precio que se acaba de cambiar
 *    tiene que verse al recargar, o el operador lo cambia dos veces.
 */

const API_URL = process.env['SAHANA_API_URL'] ?? 'http://localhost:3000';

/** La sesión caducó o no existe. Quien la reciba manda a `/panel/entrar`. */
export class SesionCaducada extends Error {
  constructor() {
    super('La sesión caducó.');
  }
}

export class PanelApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly code?: string,
  ) {
    super(detail);
  }
}

export interface Problema {
  detail?: string;
  code?: string;
}

async function llamar<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const acceso = token ?? (await tokenDeAcceso());
  if (!acceso) throw new SesionCaducada();

  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${acceso}`,
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (res.status === 401 || res.status === 403) {
    // 403 también: el guardia responde lo mismo a «no traes token» y a «tu
    // token no vale ya». Distinguirlos desde fuera no se puede, y tratar el
    // 403 como error de permisos dejaría al operador mirando «acción no
    // permitida» cuando lo único que pasó es que llevaba media hora sin tocar
    // la pantalla.
    throw new SesionCaducada();
  }

  if (!res.ok) {
    let problema: Problema = {};
    try {
      problema = (await res.json()) as Problema;
    } catch {
      problema = {};
    }
    throw new PanelApiError(
      res.status,
      problema.detail ?? `La API respondió ${res.status}.`,
      problema.code,
    );
  }
  // 204 y compañía: no hay cuerpo que leer.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --------------------------------------------------------------- Tipos

export interface Perfil {
  userId: string;
  tenantId: string;
  permissions: string[];
}

export interface ResumenDeHoy {
  businessDate: string;
  comparedDate: string;
  orders: number;
  cancelled: number;
  netRevenue: string;
  averageTicket: string;
  comparedOrders: number;
  comparedNetRevenue: string;
  changeBps: number | null;
  byBrand: Array<{
    key: string;
    label: string;
    orders: number;
    cancelled: number;
    netRevenue: string;
  }>;
  byChannel: Array<{
    key: string;
    label: string;
    orders: number;
    cancelled: number;
    netRevenue: string;
  }>;
  activeNow: number;
}

export interface Estructura {
  companies: Array<{ id: string; legalName: string; taxId: string }>;
  brands: Array<{ id: string; name: string; slug: string; active: boolean }>;
  locations: Array<{ id: string; name: string; address: string }>;
  kitchens: Array<{ id: string; name: string; locationId: string }>;
}

export interface ProductoDelPanel {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  sku: string | null;
  name: string;
  active: boolean;
  isCombo: boolean;
  prepMinutes: number;
  rowVersion: number;
  prices: Array<{
    channel: string | null;
    locationId: string | null;
    price: string;
    active: boolean;
  }>;
  pauses: Array<{ channel: string; until: string | null }>;
}

/** Pedido tal como lo lista la API (subconjunto de `OrderSummary`). */
export interface Importe {
  minorUnits: number;
  currency: string;
  scale: number;
}

export interface PedidoDelPanel {
  id: string;
  orderNumber: number;
  status: string;
  channel: string;
  brandId: string;
  createdAt: string;
  total: Importe;
}

/** Lo que llegó del canal para un pedido apartado (RN-ORD-10). */
export interface DetalleDeExcepcion {
  orderId: string;
  orderNumber: number;
  channel: string;
  brandId: string;
  externalRef: string | null;
  reason: string | null;
  customerName: string | null;
  customerPhone: string | null;
  createdAt: string;
  rawPayload: unknown;
}

/** Producto vendible en un canal, con lo que hay que elegir para pedirlo. */
export interface ProductoVendible {
  id: string;
  name: string;
  modifierGroups: Array<{
    id: string;
    name: string;
    minSelections: number;
    maxSelections: number;
    options: Array<{ id: string; name: string }>;
  }>;
}

/** Pedido con sus líneas, para la trazabilidad (specs/ux/03). */
export interface PedidoConDetalle {
  id: string;
  orderNumber: number;
  status: string;
  channel: string;
  createdAt: string;
  total: Importe;
  externalRef: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  cancelReason: string | null;
  acceptedAt: string | null;
  closedAt: string | null;
  lines: Array<{
    id: string;
    productName: string;
    quantity: number;
    lineTotal: string;
    notes: string | null;
    isAdjustment: boolean;
  }>;
}

export interface HitoDelPedido {
  occurredAt: string;
  event: string;
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  reason: string | null;
}

export interface PoliticaDeAceptacion {
  brandId: string | null;
  channel: string | null;
  autoAccept: boolean;
  alertAfterMinutes: number;
  autoRejectAfterMinutes: number;
}

export interface ExistenciaDelPanel {
  warehouseId: string;
  warehouseName: string;
  itemId: string;
  itemName: string;
  unit: string;
  quantity: string;
  minStock: string | null;
  belowMinimum: boolean;
}

export interface RecetaDelPanel {
  id: string;
  name: string;
  productId: string | null;
  productName: string | null;
  yieldQuantity: string;
  yieldUnit: string;
  lines: Array<{
    id: string;
    kind: string;
    name: string;
    quantity: string;
    wasteBps: number;
  }>;
}

export interface MovimientoDeKardex {
  id: string;
  occurredAt: string;
  kind: string;
  itemId: string;
  itemName: string;
  warehouseName: string;
  unit: string;
  quantity: string;
  unitCost: string;
  orderId: string | null;
  orderNumber: number | null;
  reason: string | null;
}

export interface TurnoDeCaja {
  id: string;
  locationId: string;
  openedBy: string;
  closedBy: string | null;
  status: 'open' | 'closing' | 'closed';
  openingFloat: Importe;
  declaredCash: Importe | null;
  expectedCash: Importe | null;
  difference: Importe | null;
  differenceReason: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface ArqueoDeTurno {
  sessionId: string;
  openingFloat: Importe;
  expectedCash: Importe;
  byKind: Record<string, Importe>;
  byMethod: Record<string, Importe>;
  movements: number;
}

export interface CartaMuerta {
  id: string;
  provider: string;
  deliveryId: string;
  attempts: number;
  lastError: string | null;
  receivedAt: string;
}

export interface DocumentoDelPanel {
  id: string;
  orderId: string | null;
  docType: string;
  number: string | null;
  status: string;
  total: string;
  issuedAt: string;
  rejectionReason: string | null;
  attempts: number;
}

/** Lo que el bot entrega al humano al derivar (RN-CNV-02). */
export interface ResumenDeDerivacion {
  intent: string;
  captured?: Record<string, unknown>;
  cart?: unknown;
  notes?: string;
}

export interface ConversacionDelPanel {
  id: string;
  brandId: string;
  brandName: string;
  channel: string;
  contactPhone: string;
  contactName: string | null;
  status: string;
  assigneeId: string | null;
  queue: string;
  aiEnabled: boolean;
  lastMsgAt: string | null;
  /** Ventana de 24 h, ya redactada por el dominio (RN-CNV-03). */
  window: {
    state: string;
    minutesRemaining: number;
    canSendFreeform: boolean;
    label: string;
  };
  messageCount: number;
  costTotal: string;
  tags: string[];
  handoffAt: string | null;
  handoffSummary: ResumenDeDerivacion | null;
}

export interface MensajeDelPanel {
  id: string;
  direction: string;
  authorType: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: string;
}

export interface ConexionDelPanel {
  id: string;
  provider: string;
  channel: string;
  brandId: string;
  status: string;
}

// ------------------------------------------------------------ Llamadas

export const panel = {
  /** Login: es la única llamada sin token, y por eso no pasa por `llamar`. */
  async entrar(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const res = await fetch(`${API_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    });
    if (!res.ok) {
      // Sin detalle de la API: «usuario no encontrado» frente a «contraseña
      // incorrecta» le dice a quien prueba qué correos existen.
      throw new PanelApiError(res.status, 'Correo o contraseña incorrectos.');
    }
    return (await res.json()) as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    };
  },

  async refrescar(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    if (!res.ok) throw new SesionCaducada();
    return (await res.json()) as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    };
  },

  async salir(refreshToken: string): Promise<void> {
    await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    }).catch(() => {
      // Cerrar sesión NUNCA debe fallar de cara al usuario: la cookie se borra
      // igual, y una sesión huérfana en el servidor caduca sola.
    });
  },

  perfil: (): Promise<Perfil> => llamar<Perfil>('/auth/me'),

  hoy: (): Promise<ResumenDeHoy> => llamar<ResumenDeHoy>('/analytics/today'),

  estructura: (): Promise<Estructura> => llamar<Estructura>('/organization'),

  productos: (brandId: string): Promise<ProductoDelPanel[]> =>
    llamar<ProductoDelPanel[]>(
      `/catalog/products?brand=${encodeURIComponent(brandId)}`,
    ),

  ponerPrecio: (input: {
    productId: string;
    channel?: string | null;
    priceMinor: number;
  }): Promise<unknown> =>
    llamar('/catalog/prices', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  crearProducto: (input: {
    brandId: string;
    name: string;
    sku?: string;
    prepMinutes?: number;
  }): Promise<{ id: string }> =>
    llamar<{ id: string }>('/catalog/products', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  pausar: (productId: string, channels: string[], reason: string) =>
    llamar(`/catalog/products/${productId}/pause`, {
      method: 'POST',
      body: JSON.stringify({ channels, reason }),
    }),

  reanudar: (productId: string, channels: string[]) =>
    llamar(`/catalog/products/${productId}/resume`, {
      method: 'POST',
      body: JSON.stringify({ channels }),
    }),

  crearMarca: (input: {
    companyId: string;
    name: string;
  }): Promise<{ id: string; slug: string }> =>
    llamar<{ id: string; slug: string }>('/org/brands', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * La carta RESUELTA para un canal: solo lo que ahí se puede vender.
   *
   * En la bandeja de excepciones importa más que en ningún otro sitio. Ofrecer
   * la carta entera dejaría elegir un plato sin precio en ese canal o pausado,
   * y el pedido volvería a fallar al resolverlo — con el operador convencido
   * de que ya lo había arreglado.
   */
  vendibles: (brandId: string, channel: string): Promise<ProductoVendible[]> =>
    llamar<{ products: ProductoVendible[] }>(
      `/catalog/resolved?brand=${encodeURIComponent(brandId)}&channel=${encodeURIComponent(channel)}`,
    ).then((c) => c.products),

  resolverMapeo: (
    orderId: string,
    lines: Array<{
      productId: string;
      quantity: number;
      modifierOptionIds?: string[];
    }>,
  ): Promise<unknown> =>
    llamar(`/orders/${orderId}/resolve-mapping`, {
      method: 'POST',
      body: JSON.stringify({ lines }),
    }),

  pedidos: (
    filtros: {
      status?: string;
      limit?: number;
    } = {},
  ): Promise<PedidoDelPanel[]> => {
    const q = new URLSearchParams();
    if (filtros.status) q.set('status', filtros.status);
    if (filtros.limit) q.set('limit', String(filtros.limit));
    const cadena = q.toString();
    return llamar<PedidoDelPanel[]>(`/orders${cadena ? `?${cadena}` : ''}`);
  },

  pedido: (id: string): Promise<PedidoConDetalle> =>
    llamar<PedidoConDetalle>(`/orders/${id}/detail`),

  hitos: (id: string): Promise<HitoDelPedido[]> =>
    llamar<HitoDelPedido[]>(`/orders/${id}/timeline`),

  politicasDeAceptacion: (): Promise<PoliticaDeAceptacion[]> =>
    llamar<PoliticaDeAceptacion[]>('/ordering/acceptance-policies'),

  aceptarPedido: (orderId: string): Promise<unknown> =>
    llamar(`/orders/${orderId}/accept`, { method: 'POST' }),

  cartasMuertas: (): Promise<CartaMuerta[]> =>
    llamar<CartaMuerta[]>('/integrations/dead-letters'),

  reintentarCartaMuerta: (id: string): Promise<unknown> =>
    llamar(`/integrations/dead-letters/${id}/retry`, { method: 'POST' }),

  documentos: (status?: string): Promise<DocumentoDelPanel[]> =>
    llamar<DocumentoDelPanel[]>(
      status ? `/documents?status=${encodeURIComponent(status)}` : '/documents',
    ),

  existencias: (): Promise<ExistenciaDelPanel[]> =>
    llamar<ExistenciaDelPanel[]>('/inventory/stock'),

  kardex: (
    filtros: { item?: string; limit?: number } = {},
  ): Promise<MovimientoDeKardex[]> => {
    const q = new URLSearchParams();
    if (filtros.item) q.set('item', filtros.item);
    if (filtros.limit) q.set('limit', String(filtros.limit));
    const cadena = q.toString();
    return llamar<MovimientoDeKardex[]>(
      `/inventory/movements${cadena ? `?${cadena}` : ''}`,
    );
  },

  insumos: (): Promise<
    Array<{ id: string; name: string; unit: string; unitCost: string }>
  > =>
    llamar<Array<{ id: string; name: string; unit: string; unitCost: string }>>(
      '/inventory/items',
    ),

  recetas: (): Promise<RecetaDelPanel[]> =>
    llamar<RecetaDelPanel[]>('/inventory/recipes'),

  guardarInsumo: (input: {
    sku?: string;
    name: string;
    unit: string;
    unitCostMinor: number;
    minStock?: string;
  }): Promise<unknown> =>
    llamar('/inventory/items', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  guardarReceta: (input: {
    name: string;
    productId?: string;
    yieldQuantity: string;
    yieldUnit: string;
    lines: Array<{ itemId: string; quantity: string }>;
  }): Promise<unknown> =>
    llamar('/inventory/recipes', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  turnos: (): Promise<TurnoDeCaja[]> => llamar<TurnoDeCaja[]>('/cash-sessions'),

  arqueo: (sessionId: string): Promise<ArqueoDeTurno> =>
    llamar<ArqueoDeTurno>(`/cash-sessions/${sessionId}/summary`),

  conversaciones: (
    filtros: { status?: string; queue?: string; search?: string } = {},
  ): Promise<ConversacionDelPanel[]> => {
    const q = new URLSearchParams();
    if (filtros.status) q.set('status', filtros.status);
    if (filtros.queue) q.set('queue', filtros.queue);
    if (filtros.search) q.set('search', filtros.search);
    const cadena = q.toString();
    return llamar<ConversacionDelPanel[]>(
      `/conversations${cadena ? `?${cadena}` : ''}`,
    );
  },

  conversacion: (id: string): Promise<ConversacionDelPanel> =>
    llamar<ConversacionDelPanel>(`/conversations/${id}`),

  /**
   * El hilo CON las notas internas.
   *
   * Se piden explícitamente porque la API no las da por defecto (RN-CNV-07):
   * quien consulta sin declararlo suele ir a enseñar el hilo a alguien. Aquí
   * sí se piden — esta pantalla es la del agente, y una nota que su autor no
   * puede releer no sirve para nada.
   */
  mensajes: (id: string): Promise<MensajeDelPanel[]> =>
    llamar<MensajeDelPanel[]>(
      `/conversations/${id}/messages?includeNotes=true`,
    ),

  responder: (
    id: string,
    input: { kind: 'text' | 'note'; text: string },
  ): Promise<unknown> =>
    llamar(`/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  asignarme: (id: string, userId: string): Promise<unknown> =>
    llamar(`/conversations/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ assigneeId: userId }),
    }),

  resolverConversacion: (id: string): Promise<unknown> =>
    llamar(`/conversations/${id}/resolve`, { method: 'POST' }),

  excepciones: (): Promise<PedidoDelPanel[]> =>
    llamar<PedidoDelPanel[]>('/orders/exceptions'),

  excepcion: (orderId: string): Promise<DetalleDeExcepcion> =>
    llamar<DetalleDeExcepcion>(`/orders/${orderId}/exception`),

  rechazarPedido: (orderId: string, reason: string): Promise<unknown> =>
    llamar(`/orders/${orderId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  conexiones: (): Promise<ConexionDelPanel[]> =>
    llamar<ConexionDelPanel[]>('/integrations/connections'),

  mapearSku: (input: {
    connectionId: string;
    externalSku: string;
    productId: string;
  }): Promise<unknown> =>
    llamar('/integrations/catalog-map', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  crearLocal: (input: {
    companyId: string;
    name: string;
    address: string;
  }): Promise<{ id: string }> =>
    llamar<{ id: string }>('/org/locations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
