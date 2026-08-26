import type { Money } from '@sahana/domain';
import type { LineaDeTicket } from './venta';
import { totalDeLinea, totalDeTicket } from './venta';

/**
 * Impresión desde el POS, contra el `print-agent` de la caja (ADR-0008).
 *
 * ### Por qué el agente y no la API
 *
 * La impresora está **en el mostrador**, colgada de la red del local, y a
 * menudo es una térmica USB sin IP. El servidor no puede alcanzarla, y aunque
 * pudiera, imprimir por internet significa que un corte de red deja a la cocina
 * sin comandas — justo cuando el POS sí puede seguir vendiendo. El agente corre
 * en la misma red que la tablet, así que **imprimir funciona sin internet**,
 * igual que cobrar.
 *
 * El agente ya existía completo —cola propia, reintentos, ESC/POS, reimprimir—
 * y **la tablet no le mandaba nada**. Esto es el cable.
 *
 * ### Lo que NO se hace aquí
 *
 * Formatear importes. Llegan ya convertidos con `Money`, que es el mismo
 * cálculo del servidor: si el agente los formateara, la precuenta y la boleta
 * podrían no cuadrar, y eso en Perú es un problema tributario.
 */

export interface ConfiguracionDeImpresion {
  /** `http://192.168.1.50:7443` — el agente vive en la red del local. */
  baseUrl: string;
  /** Token de emparejamiento del agente. Va en `x-agent-token`. */
  token: string;
  /** Nombre de la impresora de cocina, tal como la conoce el agente. */
  impresoraCocina: string;
  /** Nombre de la impresora del mostrador (precuenta y comprobante). */
  impresoraMostrador: string;
}

export interface SaludDeImpresion {
  status: string;
  pendingJobs: number;
  failedJobs: number;
  printers: Array<{ printer: string; reachable: boolean; pendingJobs: number }>;
}

export class ImpresionNoDisponible extends Error {
  constructor(motivo: string) {
    super(motivo);
  }
}

/**
 * Importe a céntimos, redondeando media hacia arriba.
 *
 * El dominio guarda cuatro decimales y el papel enseña dos, así que hay que
 * redondear en algún momento. **Truncando no cuadra**: 116.00 con IGV incluido
 * da una base de 98.3050 y un impuesto de 17.6950, que truncados salen 98.30 y
 * 17.69 — y 98.30 + 17.69 = 115.99. Una precuenta cuyas partes no suman el
 * total es la primera cosa que un cliente señala con el dedo.
 */
function aCentimos(m: Money): number {
  const signo = m.minorUnits < 0 ? -1 : 1;
  return signo * Math.round(Math.abs(m.minorUnits) / 100);
}

function solesDeCentimos(centimos: number): string {
  const signo = centimos < 0 ? '-' : '';
  const abs = Math.abs(centimos);
  return `${signo}S/ ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function soles(m: Money): string {
  return solesDeCentimos(aCentimos(m));
}

async function llamarAgente<T>(
  cfg: ConfiguracionDeImpresion,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-agent-token': cfg.token,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // El agente está apagado, la tablet cambió de wifi o la IP cambió. Es lo
    // más común de largo, y hay que decirlo distinto de «la impresora no tiene
    // papel»: se arreglan en sitios distintos.
    throw new ImpresionNoDisponible(
      'No encuentro el agente de impresión. ¿Está encendida la computadora de la caja?',
    );
  }
  if (!res.ok) {
    let detalle = `El agente respondió ${res.status}.`;
    try {
      const cuerpo = (await res.json()) as { error?: string };
      if (cuerpo.error) detalle = cuerpo.error;
    } catch {
      // Sin cuerpo legible: se queda el genérico.
    }
    throw new ImpresionNoDisponible(detalle);
  }
  return (await res.json()) as T;
}

export const impresion = {
  salud: (cfg: ConfiguracionDeImpresion): Promise<SaludDeImpresion> =>
    llamarAgente<SaludDeImpresion>(cfg, '/health'),

  /**
   * Comanda a cocina.
   *
   * El `jobId` se DERIVA aquí del id de la venta, no lo pasa quien llama: la
   * cola del agente deduplica por ese id, así que reintentar el envío —el
   * cajero pulsa dos veces porque no oyó la impresora— no imprime dos
   * comandas y la cocina no prepara el pedido dos veces. Derivarlo dentro es
   * lo que impide el error contrario: usar el MISMO id para la comanda y la
   * precuenta haría que la segunda se descartara en silencio.
   */
  comanda: (
    cfg: ConfiguracionDeImpresion,
    datos: {
      /** Id de la venta (el ULID del POS). El del trabajo se deriva de él. */
      ventaId: string;
      orderNumber: number;
      brandName: string;
      stationName: string;
      lines: readonly LineaDeTicket[];
      customerName?: string;
      notes?: string;
    },
  ): Promise<{ jobId: string; status: string }> =>
    llamarAgente(cfg, '/print/kitchen', {
      method: 'POST',
      body: JSON.stringify({
        jobId: `${datos.ventaId}-cocina`,
        printer: cfg.impresoraCocina,
        orderNumber: datos.orderNumber,
        brandName: datos.brandName,
        stationName: datos.stationName,
        channel: 'pos',
        ...(datos.customerName ? { customerName: datos.customerName } : {}),
        // La comanda NO lleva precios. Es deliberado: la cocina no cobra, y un
        // papel con importes en la zona de preparación es una fuente de
        // confusión y de reclamos.
        lines: datos.lines.map((l) => ({
          quantity: l.quantity,
          productName: l.productName,
          ...(l.modifiers.length > 0
            ? { modifiersText: l.modifiers.map((m) => m.name).join(', ') }
            : {}),
          // Solo si hay alguno: mandar una lista vacía haría que el agente
          // imprimiera una advertencia en blanco, y una advertencia que sale
          // en cada línea se deja de leer.
          ...(l.allergens.length > 0 ? { allergens: l.allergens } : {}),
        })),
        ...(datos.notes ? { notes: datos.notes } : {}),
      }),
    }),

  /** Precuenta: lo que el cliente pide para revisar antes de pagar. */
  precuenta: (
    cfg: ConfiguracionDeImpresion,
    datos: {
      ventaId: string;
      orderNumber: number;
      brandName: string;
      locationName: string;
      lines: readonly LineaDeTicket[];
      taxRateBps?: number;
    },
  ): Promise<{ jobId: string; status: string }> => {
    const total = totalDeTicket(datos.lines);
    // El precio del canal `pos` ya INCLUYE IGV (RN-T05), así que el impuesto se
    // desglosa hacia atrás. Se hace con Money y aritmética entera; el agente
    // solo pinta las cadenas que recibe.
    const bps = datos.taxRateBps ?? 1_800;
    const base = total.multiplyByRatio(10_000, 10_000 + bps);

    // El impuesto se deriva de la RESTA DE LO IMPRESO, no del cálculo exacto:
    // así base + impuesto siempre da el total que se cobra, aunque el
    // redondeo a céntimos se coma una milésima. Al revés —redondear los tres
    // por separado— produce papeles que no suman.
    const totalCentimos = aCentimos(total);
    const baseCentimos = aCentimos(base);
    const impuestoCentimos = totalCentimos - baseCentimos;

    return llamarAgente(cfg, '/print/precheck', {
      method: 'POST',
      body: JSON.stringify({
        jobId: `${datos.ventaId}-precuenta`,
        printer: cfg.impresoraMostrador,
        orderNumber: datos.orderNumber,
        brandName: datos.brandName,
        locationName: datos.locationName,
        lines: datos.lines.map((l) => ({
          quantity: l.quantity,
          productName: l.productName,
          lineTotal: soles(totalDeLinea(l)),
        })),
        subtotal: solesDeCentimos(baseCentimos),
        total: solesDeCentimos(totalCentimos),
        taxLabel: `IGV ${(bps / 100).toFixed(0)} %`,
        tax: solesDeCentimos(impuestoCentimos),
      }),
    });
  },

  reimprimir: (
    cfg: ConfiguracionDeImpresion,
    jobId: string,
  ): Promise<{ jobId: string }> =>
    llamarAgente(cfg, `/jobs/${jobId}/reprint`, { method: 'POST' }),
};
