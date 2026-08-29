/**
 * Cliente de la API del POS.
 *
 * Regla que ordena el archivo: **nada de aquí se llama en el camino de la
 * venta**. Emparejar, entrar, descargar la carta y sincronizar sí van por red;
 * cobrar, no. Un POS que necesita al servidor para cerrar una venta deja de
 * cobrar cuando se cae el router, y en un local eso es cerrar la caja.
 */

const API_URL =
  (import.meta.env['VITE_SAHANA_API_URL'] as string | undefined) ??
  'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly code?: string,
  ) {
    super(detail);
  }
}

/** La red no está. Se distingue de un error del servidor: uno se reintenta solo. */
export class SinRed extends Error {
  constructor() {
    super('Sin conexión.');
  }
}

interface Problema {
  detail?: string;
  code?: string;
}

async function llamar<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // `fetch` solo rechaza por red: cualquier respuesta del servidor, incluida
    // un 500, resuelve. Así que aquí estamos sin conexión de verdad.
    throw new SinRed();
  }

  if (!res.ok) {
    let problema: Problema = {};
    try {
      problema = (await res.json()) as Problema;
    } catch {
      problema = {};
    }
    throw new ApiError(
      res.status,
      problema.detail ?? `La API respondió ${res.status}.`,
      problema.code,
    );
  }
  return (await res.json()) as T;
}

// ------------------------------------------------------------------ Tipos

export interface DispositivoEmparejado {
  deviceId: string;
  deviceToken: string;
  tenantId: string;
  locationId: string | null;
  name: string;
}

export interface Operador {
  userId: string;
  fullName: string;
}

export interface SesionDePos {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  locationId: string | null;
}

export interface OpcionDeModificador {
  id: string;
  name: string;
  priceDeltaMinor: number;
  available: boolean;
}

export interface GrupoDeModificadores {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  allowRepeat: boolean;
  options: OpcionDeModificador[];
}

export interface ProductoDeCarta {
  id: string;
  name: string;
  categoryId: string | null;
  /**
   * Alérgenos declarados. Llega de una columna `jsonb`, así que el tipo es
   * `unknown` a propósito: se normaliza con `alergenosDe` de `@sahana/domain`
   * antes de usarlo.
   */
  allergens?: unknown;
  price: { minorUnits: number; currency: string; scale: number };
  modifierGroups: GrupoDeModificadores[];
}

export interface CartaResuelta {
  brandId: string;
  channel: string;
  resolvedAt: string;
  categories: Array<{ id: string; name: string; sortOrder: number }>;
  products: ProductoDeCarta[];
}

export interface LineaOffline {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  modifiersTotalMinor?: number;
  modifiers?: Array<{ id: string; name: string; priceDeltaMinor: number }>;
  notes?: string;
}

export interface PedidoOffline {
  clientId: string;
  brandId: string;
  locationId: string;
  channel?: string;
  lines: LineaOffline[];
  totalMinor: number;
  soldAt: string;
  paymentMethod?: string;
}

export interface ResultadoDeSincronizacion {
  results: Array<{
    clientId: string;
    outcome: string;
    orderId?: string;
    orderNumber?: number;
    alerts?: string[];
    error?: string;
  }>;
  accepted: number;
  duplicates: number;
  failed: number;
}

/** Un pedido esperando empaque, con TODAS sus líneas. */
export interface PedidoParaEmpacar {
  orderId: string;
  orderNumber: number;
  brandId: string;
  brandName: string;
  channel: string;
  promisedAt: string | null;
  readyAt: string | null;
  lines: Array<{
    id: string;
    productName: string;
    quantity: number;
    modifiersText: string | null;
    notes: string | null;
  }>;
}

export interface TicketDeCocina {
  id: string;
  orderId: string;
  orderNumber: number;
  stationId: string;
  stationName: string;
  brandId: string;
  brandName: string;
  /** De dónde vino: un Rappi tiene un repartidor en la puerta, un web no. */
  channel: string;
  status: string;
  promisedAt: string | null;
  createdAt: string;
  /** Minutos desde que entró en cocina: es lo que el cocinero mira primero. */
  waitingMinutes: number;
  late: boolean;
  rowVersion: number;
  lines: Array<{
    id: string;
    productName: string;
    quantity: number;
    modifiersText: string | null;
    /**
     * Alérgenos declarados al hacer el pedido. `null` es **no se registró**
     * —comandas anteriores a la migración 0037— y NO «no lleva ninguno», que
     * es `[]`. La cocina tiene que poder distinguirlo.
     */
    allergens?: string[] | null;
    notes: string | null;
  }>;
}

export interface Dinero {
  minorUnits: number;
  currency: string;
  scale: number;
}

export interface SesionDeCaja {
  id: string;
  locationId: string;
  status: 'open' | 'closing' | 'closed';
  openingFloat: Dinero;
  declaredCash: Dinero | null;
  expectedCash: Dinero | null;
  difference: Dinero | null;
  openedAt: string;
  closedAt: string | null;
}

export interface ArqueoDeCaja {
  sessionId: string;
  openingFloat: Dinero;
  /** Fondo + entradas − salidas EN EFECTIVO: lo que debería haber en gaveta. */
  expectedCash: Dinero;
  byKind: Record<string, Dinero>;
  byMethod: Record<string, Dinero>;
  movements: number;
}

// --------------------------------------------------------------- Llamadas

export const api = {
  /** Empareja la tablet con un código de un solo uso. Sin sesión: no la tiene. */
  emparejar: (
    code: string,
    deviceName: string,
  ): Promise<DispositivoEmparejado> =>
    llamar<DispositivoEmparejado>('/devices/pair', {
      method: 'POST',
      body: JSON.stringify({ code, deviceName }),
    }),

  operadores: (
    deviceToken: string,
  ): Promise<{
    device: { deviceId: string; deviceName: string; locationId: string | null };
    operators: Operador[];
  }> =>
    llamar('/auth/pos/operators', {
      method: 'POST',
      body: JSON.stringify({ deviceToken }),
    }),

  entrar: (
    deviceToken: string,
    userId: string,
    pin: string,
  ): Promise<SesionDePos> =>
    llamar<SesionDePos>('/auth/pos/login', {
      method: 'POST',
      body: JSON.stringify({ deviceToken, userId, pin }),
    }),

  refrescar: (
    refreshToken: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> =>
    llamar('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),

  marcas: (
    token: string,
  ): Promise<{
    brands: Array<{ id: string; name: string; active: boolean }>;
  }> => llamar('/organization', {}, token),

  /**
   * La carta del canal `pos`, ya resuelta por el servidor.
   *
   * Se descarga entera y se guarda en el dispositivo. El POS no vuelve a
   * pedirla para vender: la lee de IndexedDB, y por eso puede vender sin red.
   */
  carta: (token: string, brandId: string): Promise<CartaResuelta> =>
    llamar<CartaResuelta>(
      `/catalog/resolved?brand=${encodeURIComponent(brandId)}&channel=pos`,
      {},
      token,
    ),

  sincronizar: (
    token: string,
    orders: PedidoOffline[],
  ): Promise<ResultadoDeSincronizacion> =>
    llamar<ResultadoDeSincronizacion>(
      '/orders/sync',
      { method: 'POST', body: JSON.stringify({ orders }) },
      token,
    ),

  /** Cola de una estación o de una cocina entera. Cero toques para verla. */
  cola: (
    token: string,
    filtro: { stationId?: string; kitchenId?: string },
  ): Promise<TicketDeCocina[]> => {
    const q = filtro.stationId
      ? `station=${encodeURIComponent(filtro.stationId)}`
      : `kitchen=${encodeURIComponent(filtro.kitchenId ?? '')}`;
    return llamar<TicketDeCocina[]>(`/kitchen/queue?${q}`, {}, token);
  },

  /**
   * Lo que espera empaque, y el empaque en sí (RN-KIT-03, ux/02 §Empaque).
   *
   * Va por PEDIDO y no por ticket a propósito: un pedido repartido entre
   * parrilla y frío se empaca una vez, mirando la bolsa completa. Empacar
   * ticket a ticket sería la forma más segura de mandar media bolsa.
   */
  paraEmpacar: (
    token: string,
    kitchenId: string,
  ): Promise<PedidoParaEmpacar[]> =>
    llamar<PedidoParaEmpacar[]>(
      `/kitchen/packing?kitchen=${encodeURIComponent(kitchenId)}`,
      {},
      token,
    ),

  empacar: (
    token: string,
    orderId: string,
    checkedLineIds: string[],
  ): Promise<{ brandName: string; lines: number }> =>
    llamar<{ brandName: string; lines: number }>(
      `/kitchen/orders/${orderId}/pack`,
      { method: 'POST', body: JSON.stringify({ checkedLineIds }) },
      token,
    ),

  // ---------------------------------------------------------------- Caja
  //
  // La caja SÍ necesita red, y es una diferencia importante con la venta:
  // abrir y cerrar turno son actos de control —quién responde del dinero— y no
  // se pueden hacer a ciegas contra un estado local que quizá no cuadre con el
  // servidor. Vender sin red sí; arquear sin red, no.

  cajas: (token: string, locationId: string): Promise<SesionDeCaja[]> =>
    llamar<SesionDeCaja[]>(
      `/cash-sessions?location=${encodeURIComponent(locationId)}`,
      {},
      token,
    ),

  abrirCaja: (
    token: string,
    input: {
      locationId: string;
      deviceId?: string;
      openingFloatMinor?: number;
    },
  ): Promise<SesionDeCaja> =>
    llamar<SesionDeCaja>(
      '/cash-sessions',
      { method: 'POST', body: JSON.stringify(input) },
      token,
    ),

  arqueo: (token: string, sessionId: string): Promise<ArqueoDeCaja> =>
    llamar<ArqueoDeCaja>(`/cash-sessions/${sessionId}/summary`, {}, token),

  cerrarCaja: (
    token: string,
    sessionId: string,
    input: {
      declaredCashMinor: number;
      differenceReason?: string;
      supervisorId?: string;
      supervisorPin?: string;
    },
  ): Promise<SesionDeCaja> =>
    llamar<SesionDeCaja>(
      `/cash-sessions/${sessionId}/close`,
      { method: 'POST', body: JSON.stringify(input) },
      token,
    ),

  /**
   * Avanza un ticket. Sin `If-Match`: la API no lo pide aquí, y mandarlo
   * sugeriría un control de concurrencia que no existe. Dos cocineros tocando
   * el mismo ticket a la vez producen la misma transición, que es idempotente.
   */
  avanzarTicket: (
    token: string,
    ticketId: string,
    accion: 'start' | 'ready',
  ): Promise<unknown> =>
    llamar(`/kitchen/tickets/${ticketId}/${accion}`, { method: 'POST' }, token),

  /**
   * Deshace el último toque de un ticket (DT-11 saldada).
   *
   * El servidor decide si se puede: hay una ventana de tiempo y el pedido tiene
   * que seguir en cocina. La pantalla enseña el botón unos segundos, pero la
   * regla no vive aquí — un reloj de tablet no es una autorización.
   */
  deshacerTicket: (token: string, ticketId: string): Promise<unknown> =>
    llamar(`/kitchen/tickets/${ticketId}/undo`, { method: 'POST' }, token),
};
