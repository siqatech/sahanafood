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

export interface PasarelaDelPanel {
  id: string;
  provider: string;
  brandId: string | null;
  methods: string[];
  status: string;
  /** Ruta que hay que configurar en el panel de la pasarela. */
  callbackPath: string;
  createdAt: string;
}

export interface AspectoDeTienda {
  displayName: string | null;
  tagline: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  colorBase: string | null;
  colorHover: string | null;
  colorTexto: string | null;
}

export interface ClaveDeTienda {
  id: string;
  brandId: string;
  /** Pública por diseño: va en el HTML de la web del cliente (ADR-0020). */
  key: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface PromocionDelPanel {
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
  /** El mismo texto que lee un cliente en la tienda. */
  label: string;
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

/** Un día de la serie de ventas. */
export interface PuntoDeVenta {
  businessDate: string;
  orders: number;
  netRevenue: string;
}

/**
 * Dos series de la MISMA longitud, alineadas por posición: el día 1 de una
 * corresponde al día 1 de la otra. Emparejarlas por fecha las desplazaría un
 * periodo entero.
 */
export interface SerieDeVentas {
  days: number;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  current: PuntoDeVenta[];
  previous: PuntoDeVenta[];
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
  imageUrl: string | null;
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

export interface UsuarioDelPanel {
  id: string;
  email: string;
  fullName: string;
  status: string;
  isOwner: boolean;
  hasPin: boolean;
  roles: Array<{ code: string; name: string }>;
}

export interface DispositivoDelPanel {
  id: string;
  name: string;
  locationId: string | null;
  status: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
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

/** Un cobro y, si la hay, su devolución (spec 10, RN-PAY-03). */
export interface CobroDelPanel {
  id: string;
  orderId: string;
  reference: string;
  status: string;
  amount: string;
  currency: string;
  expiresAt: string;
  refund?:
    | {
        required: boolean;
        reason: string | null;
        requestedBy: string | null;
        approvedBy: string | null;
        refundedAt: string | null;
        attempts: number;
        lastError: string | null;
        exhausted: boolean;
      }
    | undefined;
}

/** Un contacto de WhatsApp y si está de baja (RN-T10, RN-WA-04). */
export interface ContactoDelPanel {
  id: string;
  phone: string;
  displayName: string | null;
  optedOut: boolean;
  optedOutAt: string | null;
  lastInboundAt: string | null;
}

/** Una línea del histórico de consentimiento, con el texto exacto. */
export interface ConsentimientoDelPanel {
  action: string;
  source: string;
  consentText: string;
  at: string;
}

/** Un dominio de tienda y lo que falta para que sirva (RN-STO-01). */
export interface DominioDelPanel {
  id: string;
  brandId: string;
  host: string;
  status: string;
  isSubdomain: boolean;
  verificationToken: string | null;
  verifiedAt: string | null;
}

/** La configuración del agente de una marca (spec 19). */
export interface ConfigDelAgente {
  id: string;
  brandId: string;
  version: number;
  status: string;
  identity: {
    name?: string;
    role?: string;
    personality?: string;
    tone?: string;
    length?: string;
    emojis?: boolean;
  };
  guidelines: string[];
  limits: { forbiddenTopics?: string[]; handoffMessage?: string };
  enabled: boolean;
  publishedAt: string | null;
  rules: Array<{
    id: string;
    name: string;
    priority: number;
    matchMode: string;
    enabled: boolean;
    hitCount: number;
  }>;
}

export interface VersionDelAgente {
  id: string;
  version: number;
  status: string;
  publishedAt: string | null;
}

export interface FuenteDelAgente {
  id: string;
  title: string;
  topic: string | null;
  version: number;
  useCount: number;
  active: boolean;
}

export interface PresupuestoDeIa {
  state: string;
  /** Fracción consumida, 0..1+ */
  ratio: number;
  allowLlm: boolean;
  allowDeterministic: boolean;
  reason: string;
}

/** Lo que contestaría el agente, con su traza (spec 19 §2.8). */
export interface RespuestaDePrueba {
  resolution: string;
  text: string | null;
  trace: {
    ruleName?: string;
    sourceIds: string[];
    toolsCalled: string[];
    validator?: { ok: boolean; reason?: string };
    credits: number;
    budget: string;
    promptVersion?: string;
  };
}

/** Rentabilidad de una marca en un canal (spec 16). */
export interface RentabilidadDelPanel {
  brandId: string;
  brandName: string;
  channel: string;
  orders: number;
  cancelled: number;
  grossRevenue: string;
  discounts: string;
  netRevenue: string;
  commission: string;
  foodCost: string;
  contributionMargin: string;
  marginBps: number;
  averageTicket: string;
}

/** Conciliación del día entre lo que vendimos y lo que declaramos. */
export interface ConciliacionDelPanel {
  businessDate: string;
  analyticsTotal: string;
  billingTotal: string;
  difference: string;
  matches: boolean;
  ordersWithoutDocument: number;
  documentsWithoutSale: number;
}

/** Umbrales de una cocina y su nivel actual (RN-KIT-04). */
export interface CapacidadDeCocina {
  kitchenId: string;
  maxConcurrentItems: number;
  extendMinutes: number;
  pauseThresholdItems: number | null;
  channelPauseOrder: string[];
  level: string;
  levelSince: string | null;
  enabled: boolean;
}

export interface CargaDeCocina {
  kitchenId: string;
  activeTickets: number;
  activeItems: number;
  lateTickets: number;
  byStation: Array<{
    stationId: string;
    stationName: string;
    tickets: number;
    items: number;
    oldestWaitingMinutes: number;
  }>;
}

export interface CambioDeNivel {
  fromLevel: string;
  toLevel: string;
  activeItems: number;
  channelsPaused: string[];
  ordersExtended: number;
  reason: string;
  at: string;
}

/** Un canal cerrado ahora mismo, y por quién (RN-KIT-04). */
export interface PausaDeCanal {
  channel: string;
  pausedBy: string;
  reason: string | null;
}

/** Un envío y a quién se le dio (spec 09). */
export interface EnvioDelPanel {
  id: string;
  orderId: string;
  status: string;
  courierId: string | null;
  courierName: string | null;
  externalCourier: string | null;
  codAmount: string | null;
  codCollected: boolean;
  settled: boolean;
  promisedAt: string | null;
  etaAt: string | null;
  attempts: number;
  failReason: string | null;
}

export interface RepartidorDelPanel {
  id: string;
  fullName: string;
  status: string;
  vehicle: string | null;
  activeShipments: number;
  zoneIds: string[];
}

/** El ranking de RN-DLV-01, con el motivo de cada uno. */
export interface SugerenciaDeReparto {
  courierId: string;
  name: string;
  activeShipments: number;
  score: number;
  reason: string;
}

export interface SaldoDeRepartidor {
  courierId: string;
  courierName: string;
  pendingShipments: number;
  pendingAmount: string;
}

/** Una línea del histórico (spec 17, docs/14#auditoria). */
export interface PasoDeChecklist {
  id: string;
  titulo: string;
  porQue: string;
  hecho: boolean;
  donde: string;
  opcional: boolean;
}

export interface ChecklistDeSalida {
  pasos: PasoDeChecklist[];
  hechos: number;
  /**
   * Cuántos pasos OBLIGATORIOS hay.
   *
   * Se llama así y no `total` porque la regla de ESLint que protege el dinero
   * mira los nombres de campo, y con razón: `total: number` es exactamente el
   * error que esa regla existe para impedir. Aquí es una cuenta de pasos, no un
   * importe — pero un nombre que obliga a mirar dos veces es un mal nombre.
   */
  obligatorios: number;
  listoParaAbrir: boolean;
}

export interface LineaDeAuditoria {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  traceId: string | null;
  data: Record<string, unknown>;
}

export interface DocumentoDelPanel {
  id: string;
  orderId: string | null;
  docType: string;
  number: string | null;
  status: string;
  total: string;
  issuedAt: string;
  rejectionCode: string | null;
  rejectionReason: string | null;
  attempts: number;
  /** A nombre de quién va: no se puede corregir lo que no se ve. */
  customerDocType: string;
  customerDocNumber: string | null;
  customerName: string | null;
  deferral?: { status: string; hoursRemaining: number } | undefined;
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
  locationId: string;
  status: string;
  /**
   * El cortacircuitos. `open` = el canal falló tantas veces seguidas que se
   * dejó de intentar, y eso hay que verlo: un conector con el circuito abierto
   * no recibe pedidos ni cambios de carta, y por fuera se parece a «hoy hay
   * poca venta».
   */
  circuit: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
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

  /**
   * La venta día a día con su periodo anterior.
   *
   * `ana_daily_sales` guarda la serie desde F4 y ninguna ruta la devolvía: el
   * panel tenía el dato de UN día y ninguna forma de ver la tendencia, que es
   * lo único que dice si el negocio sube o baja.
   */
  serie: (dias = 14): Promise<SerieDeVentas> =>
    llamar<SerieDeVentas>(`/analytics/series?days=${dias}`),

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

  /**
   * Pone o quita la foto. Endpoint estrecho: reenviar el producto entero por el
   * upsert borraría descripción y alérgenos, que esta lista no trae.
   */
  ponerFoto: (
    productId: string,
    imageUrl: string | null,
  ): Promise<{ id: string; imageUrl: string | null }> =>
    llamar<{ id: string; imageUrl: string | null }>(
      `/catalog/products/${productId}/image`,
      { method: 'POST', body: JSON.stringify({ imageUrl }) },
    ),

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
      /**
       * Número, referencia del canal, teléfono o nombre.
       *
       * Faltaba, y no fallaba: la pantalla ya lo pasaba —`search: q`— y aquí se
       * caía al suelo sin que TypeScript dijera nada, porque llega por
       * propagación de un objeto. El buscador de pedidos devolvía la lista
       * entera desde que se construyó y parecía funcionar: siempre había una
       * primera fila que enseñar. Es el peor modo de fallo posible en la
       * pantalla que se abre cuando suena el teléfono — se atiende al cliente
       * mirando el pedido de otro.
       */
      search?: string;
      /**
       * Canal de entrada. La API lo acepta desde F4 y este cliente lo tiraba al
       * suelo, igual que hacía con `search`: no se podía filtrar la lista por
       * canal desde ninguna pantalla.
       */
      channel?: string;
    } = {},
  ): Promise<PedidoDelPanel[]> => {
    const q = new URLSearchParams();
    if (filtros.status) q.set('status', filtros.status);
    if (filtros.search) q.set('search', filtros.search);
    if (filtros.channel) q.set('channel', filtros.channel);
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

  /** Corrige el cliente de un comprobante rechazado y lo reenvía (RN-BIL-02). */
  corregirComprobante: (
    id: string,
    input: { docType: string; docNumber?: string; legalName?: string },
  ): Promise<DocumentoDelPanel> =>
    llamar<DocumentoDelPanel>(`/documents/${id}/correct`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  reenviarComprobante: (id: string): Promise<DocumentoDelPanel> =>
    llamar<DocumentoDelPanel>(`/documents/${id}/retry`, { method: 'POST' }),

  notaDeCredito: (id: string, reason: string): Promise<DocumentoDelPanel> =>
    llamar<DocumentoDelPanel>(`/documents/${id}/credit-note`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  cobrosDe: (orderId: string): Promise<CobroDelPanel[]> =>
    llamar<CobroDelPanel[]>(`/payments/orders/${orderId}/intents`),

  devolucionesAtascadas: (): Promise<CobroDelPanel[]> =>
    llamar<CobroDelPanel[]>('/payments/refunds/stuck'),

  /** Pide la devolución. Sobre el umbral hace falta una SEGUNDA persona. */
  devolver: (
    intentId: string,
    input: { reason: string; approvedBy?: string; approverPin?: string },
  ): Promise<{ status: string; requiresApproval: boolean }> =>
    llamar<{ status: string; requiresApproval: boolean }>(
      `/payments/intents/${intentId}/refund`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  auditoria: (
    filtros: {
      action?: string;
      limit?: number;
    } = {},
  ): Promise<LineaDeAuditoria[]> => {
    const q = new URLSearchParams();
    if (filtros.action) q.set('action', filtros.action);
    q.set('limit', String(filtros.limit ?? 100));
    return llamar<{ items: LineaDeAuditoria[] }>(`/audit?${q}`).then(
      (r) => r.items,
    );
  },

  /** La checklist de salida en vivo (docs/26 §5). */
  checklist: (): Promise<ChecklistDeSalida> =>
    llamar<ChecklistDeSalida>('/onboarding/checklist'),

  accionesAuditadas: (): Promise<Array<{ action: string; count: number }>> =>
    llamar<Array<{ action: string; count: number }>>('/audit/actions'),

  contactos: (phone?: string): Promise<ContactoDelPanel[]> =>
    llamar<ContactoDelPanel[]>(
      phone
        ? `/messaging/contacts?phone=${encodeURIComponent(phone)}`
        : '/messaging/contacts',
    ),

  consentimientos: (contactId: string): Promise<ConsentimientoDelPanel[]> =>
    llamar<ConsentimientoDelPanel[]>(
      `/messaging/contacts/${contactId}/consents`,
    ),

  registrarConsentimiento: (input: {
    phone: string;
    action: 'granted' | 'revoked';
    source: string;
    consentText: string;
  }): Promise<{ contactId: string; optedOut: boolean }> =>
    llamar('/messaging/consents', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  kpiDeMensajeria: (): Promise<{
    orders: number;
    messages: number;
    average: number;
  }> =>
    llamar<{ orders: number; messages: number; average: number }>(
      '/messaging/kpi',
    ),

  dominios: (): Promise<DominioDelPanel[]> =>
    llamar<DominioDelPanel[]>('/storefront/domains'),

  pasarelas: (): Promise<PasarelaDelPanel[]> =>
    llamar<PasarelaDelPanel[]>('/payments/connections'),

  conectarPasarela: (input: {
    provider: string;
    brandId?: string;
    webhookSecret: string;
    apiKey?: string;
    methods?: string[];
  }): Promise<{ id: string; webhookToken: string; callbackPath: string }> =>
    llamar<{ id: string; webhookToken: string; callbackPath: string }>(
      '/payments/connections',
      { method: 'POST', body: JSON.stringify(input) },
    ),

  aspecto: (brandId: string): Promise<AspectoDeTienda> =>
    llamar<AspectoDeTienda>(`/storefront/branding/${brandId}`),

  guardarAspecto: (
    input: { brandId: string } & Partial<AspectoDeTienda>,
  ): Promise<AspectoDeTienda> =>
    llamar<AspectoDeTienda>('/storefront/branding', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  clavesDeTienda: (): Promise<ClaveDeTienda[]> =>
    llamar<ClaveDeTienda[]>('/storefront/keys'),

  emitirClave: (input: {
    brandId: string;
    label?: string;
  }): Promise<ClaveDeTienda & { key: string }> =>
    llamar<ClaveDeTienda & { key: string }>('/storefront/keys', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  revocarClave: (id: string): Promise<{ ok: true }> =>
    llamar<{ ok: true }>(`/storefront/keys/${id}`, { method: 'DELETE' }),

  promociones: (): Promise<PromocionDelPanel[]> =>
    llamar<PromocionDelPanel[]>('/storefront/coupons'),

  guardarPromocion: (input: {
    id?: string;
    brandId: string;
    code: string;
    kind: 'percent' | 'fixed' | 'free_delivery';
    percentBps?: number;
    amount?: string;
    minOrder?: string;
    maxUses?: number;
    active?: boolean;
    isWelcome?: boolean;
  }): Promise<PromocionDelPanel> =>
    llamar<PromocionDelPanel>('/storefront/coupons', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  registrarDominio: (input: {
    brandId: string;
    host: string;
  }): Promise<{
    id: string;
    host: string;
    status: string;
    verificationToken: string | null;
  }> =>
    llamar('/storefront/domains', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  verificarDominio: (id: string): Promise<{ ok: true }> =>
    llamar<{ ok: true }>(`/storefront/domains/${id}/verify`, {
      method: 'POST',
    }),

  crearConexion: (input: {
    provider: string;
    channel: string;
    brandId: string;
    locationId: string;
    signingSecret: string;
  }): Promise<ConexionDelPanel> =>
    llamar<ConexionDelPanel>('/integrations/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  estadoDeConexion: (id: string, status: string): Promise<ConexionDelPanel> =>
    llamar<ConexionDelPanel>(`/integrations/connections/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  configDelAgente: (brandId: string): Promise<ConfigDelAgente> =>
    llamar<ConfigDelAgente>(`/ai/config?brand=${encodeURIComponent(brandId)}`),

  versionesDelAgente: (brandId: string): Promise<VersionDelAgente[]> =>
    llamar<VersionDelAgente[]>(
      `/ai/config/versions?brand=${encodeURIComponent(brandId)}`,
    ),

  guardarConfigDelAgente: (
    id: string,
    input: Record<string, unknown>,
  ): Promise<ConfigDelAgente> =>
    llamar<ConfigDelAgente>(`/ai/config/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  publicarAgente: (id: string): Promise<ConfigDelAgente> =>
    llamar<ConfigDelAgente>(`/ai/config/${id}/publish`, { method: 'POST' }),

  revertirAgente: (id: string): Promise<ConfigDelAgente> =>
    llamar<ConfigDelAgente>(`/ai/config/${id}/rollback`, { method: 'POST' }),

  fuentesDelAgente: (): Promise<FuenteDelAgente[]> =>
    llamar<FuenteDelAgente[]>('/ai/sources'),

  guardarFuente: (input: {
    title: string;
    topic?: string;
    body: string;
  }): Promise<{ id: string; chunks: number }> =>
    llamar<{ id: string; chunks: number }>('/ai/sources', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  presupuestoDeIa: (): Promise<PresupuestoDeIa> =>
    llamar<PresupuestoDeIa>('/ai/budget'),

  probarAgente: (input: {
    conversationId: string;
    brandId: string;
    text: string;
  }): Promise<RespuestaDePrueba> =>
    llamar<RespuestaDePrueba>('/ai/sandbox', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  rentabilidad: (
    rango: {
      from?: string;
      to?: string;
    } = {},
  ): Promise<RentabilidadDelPanel[]> => {
    const q = new URLSearchParams();
    if (rango.from) q.set('from', rango.from);
    if (rango.to) q.set('to', rango.to);
    const cadena = q.toString();
    return llamar<RentabilidadDelPanel[]>(
      `/analytics/profitability${cadena ? `?${cadena}` : ''}`,
    );
  },

  conciliacion: (date?: string): Promise<ConciliacionDelPanel> =>
    llamar<ConciliacionDelPanel>(
      date
        ? `/analytics/reconciliation?date=${encodeURIComponent(date)}`
        : '/analytics/reconciliation',
    ),

  capacidad: (kitchenId: string): Promise<CapacidadDeCocina> =>
    llamar<CapacidadDeCocina>(
      `/kitchen/capacity?kitchen=${encodeURIComponent(kitchenId)}`,
    ),

  cargaDeCocina: (kitchenId: string): Promise<CargaDeCocina> =>
    llamar<CargaDeCocina>(
      `/kitchen/load?kitchen=${encodeURIComponent(kitchenId)}`,
    ),

  historialDeSaturacion: (kitchenId: string): Promise<CambioDeNivel[]> =>
    llamar<CambioDeNivel[]>(`/kitchen/capacity/${kitchenId}/history`),

  ordenSugerido: (): Promise<string[]> =>
    llamar<string[]>('/kitchen/capacity/suggested-order'),

  ponerCapacidad: (
    kitchenId: string,
    input: {
      maxConcurrentItems: number;
      extendMinutes: number;
      pauseThresholdItems?: number | null;
      channelPauseOrder?: string[];
      enabled?: boolean;
    },
  ): Promise<CapacidadDeCocina> =>
    llamar<CapacidadDeCocina>(`/kitchen/capacity/${kitchenId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  pausas: (locationId: string): Promise<PausaDeCanal[]> =>
    llamar<PausaDeCanal[]>(
      `/orders/channel-pauses?locationId=${encodeURIComponent(locationId)}`,
    ),

  ponerPausa: (input: {
    locationId: string;
    channel: string;
    paused: boolean;
    reason?: string;
    untilMinutes?: number;
  }): Promise<{ ok: true }> =>
    llamar<{ ok: true }>('/orders/channel-pauses', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  envios: (status?: string): Promise<EnvioDelPanel[]> =>
    llamar<EnvioDelPanel[]>(
      status
        ? `/delivery/shipments?status=${encodeURIComponent(status)}`
        : '/delivery/shipments',
    ),

  repartidores: (): Promise<RepartidorDelPanel[]> =>
    llamar<RepartidorDelPanel[]>('/delivery/couriers'),

  sugerencias: (shipmentId: string): Promise<SugerenciaDeReparto[]> =>
    llamar<SugerenciaDeReparto[]>(
      `/delivery/shipments/${shipmentId}/suggestions`,
    ),

  crearEnvio: (input: {
    orderId: string;
    codAmountMinor?: number;
    zoneId?: string;
  }): Promise<EnvioDelPanel> =>
    llamar<EnvioDelPanel>('/delivery/shipments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  asignarEnvio: (id: string, courierId: string): Promise<EnvioDelPanel> =>
    llamar<EnvioDelPanel>(`/delivery/shipments/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ courierId }),
    }),

  /**
   * Emite el enlace de seguimiento de un envío.
   *
   * La API existe desde T5.16 y **no la llamaba nadie**: se emitía un token que
   * ninguna pantalla componía en una URL y que ninguna página sabía abrir. El
   * seguimiento del pedido —lo que responde a «¿dónde está mi comida?», la
   * pregunta del minuto siguiente a pagar— estaba entero y era inalcanzable
   * para cualquier persona.
   */
  enlaceDeSeguimiento: (id: string): Promise<{ token: string }> =>
    llamar<{ token: string }>(`/delivery/shipments/${id}/tracking-link`, {
      method: 'POST',
    }),

  crearRepartidor: (input: {
    locationId: string;
    fullName: string;
    phone?: string;
    vehicle?: string;
  }): Promise<{ id: string; firstName: string }> =>
    llamar<{ id: string; firstName: string }>('/delivery/couriers', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  estadoRepartidor: (id: string, status: string): Promise<unknown> =>
    llamar(`/delivery/couriers/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  saldosDeReparto: (): Promise<SaldoDeRepartidor[]> =>
    llamar<SaldoDeRepartidor[]>('/delivery/couriers/balances'),

  liquidarRepartidor: (
    id: string,
    sessionId: string,
  ): Promise<{ shipments: number; amount: string }> =>
    llamar<{ shipments: number; amount: string }>(
      `/delivery/couriers/${id}/settle`,
      { method: 'POST', body: JSON.stringify({ sessionId }) },
    ),

  usuarios: (): Promise<UsuarioDelPanel[]> =>
    llamar<UsuarioDelPanel[]>('/users'),

  rolesAsignables: (): Promise<Array<{ code: string; name: string }>> =>
    llamar<Array<{ code: string; name: string }>>('/users/roles'),

  crearUsuario: (input: {
    email: string;
    fullName: string;
    password: string;
    roleCode: string;
  }): Promise<unknown> =>
    llamar('/users', { method: 'POST', body: JSON.stringify(input) }),

  cambiarRol: (userId: string, roleCode: string): Promise<unknown> =>
    llamar(`/users/${userId}/role`, {
      method: 'POST',
      body: JSON.stringify({ roleCode }),
    }),

  cambiarEstadoUsuario: (userId: string, active: boolean): Promise<unknown> =>
    llamar(`/users/${userId}/status`, {
      method: 'POST',
      body: JSON.stringify({ active }),
    }),

  dispositivos: (): Promise<DispositivoDelPanel[]> =>
    llamar<DispositivoDelPanel[]>('/devices'),

  emitirCodigo: (
    locationId?: string,
  ): Promise<{ code: string; expiresAt: string }> =>
    llamar<{ code: string; expiresAt: string }>('/devices/pairing-codes', {
      method: 'POST',
      body: JSON.stringify(locationId ? { locationId } : {}),
    }),

  revocarDispositivo: (id: string, reason: string): Promise<unknown> =>
    llamar(`/devices/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),

  ponerPin: (userId: string, pin: string): Promise<unknown> =>
    llamar('/auth/pin', {
      method: 'POST',
      body: JSON.stringify({ userId, pin }),
    }),

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
