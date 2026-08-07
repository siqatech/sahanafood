import {
  DELIVERY_HEADER,
  SIGNATURE_HEADER,
  signSimulatorPayload,
  type SimulatorPayload,
} from './simulator.connector.js';

/**
 * Generador de tráfico del simulador (spec 13: «ráfagas configurables»).
 *
 * REPRODUCIBLE POR DISEÑO: no usa `Math.random` ni el reloj. Todo sale de una
 * semilla, así que un fallo de la prueba de caos se repite tantas veces como
 * haga falta con la misma secuencia exacta de pedidos, duplicados y payloads
 * rotos. Un generador aleatorio de verdad produce fallos que solo se ven una
 * vez y no se pueden depurar.
 */

export type SimulatorScenario =
  | 'valid'
  | 'duplicate'
  | 'unknown_sku'
  | 'malformed'
  | 'bad_signature'
  | 'scheduled'
  | 'cancel';

export interface SimulatedDelivery {
  scenario: SimulatorScenario;
  deliveryId: string;
  /** Referencia del pedido en el canal; los duplicados la repiten. */
  externalRef: string;
  rawBody: string;
  headers: Record<string, string>;
  /**
   * Si el envío es legítimo (firma buena), qué debe pasar con él. La prueba de
   * caos compara contra esto: nada de «lo que salga».
   */
  expected: 'order' | 'needs_review' | 'rejected';
}

/** PRNG determinista (mulberry32). Pequeño, suficiente y sin dependencias. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GeneratorOptions {
  seed: number;
  secret: string;
  /** SKUs externos que SÍ están mapeados. */
  knownSkus: string[];
  /** SKUs externos de modificadores mapeados. */
  knownModifierSkus?: string[];
  /** Coordenada dentro de la zona de cobertura. */
  dropoff?: { address: string; lat: number; lng: number };
  /** Instante base; se pasa desde fuera para no depender del reloj. */
  now: Date;
}

/** Mezcla de escenarios por defecto: mayoría sanos, con la cola larga real. */
const MEZCLA_POR_DEFECTO: Array<[SimulatorScenario, number]> = [
  ['valid', 0.62],
  ['duplicate', 0.18],
  ['unknown_sku', 0.1],
  ['malformed', 0.06],
  ['bad_signature', 0.04],
];

function elegirEscenario(r: number): SimulatorScenario {
  let acumulado = 0;
  for (const [escenario, peso] of MEZCLA_POR_DEFECTO) {
    acumulado += peso;
    if (r < acumulado) return escenario;
  }
  return 'valid';
}

export class MarketplaceSimulator {
  private readonly rand: () => number;
  private contador = 0;
  /** Referencias ya emitidas, para poder reenviar un duplicado real. */
  private readonly emitidas: string[] = [];

  constructor(private readonly options: GeneratorOptions) {
    this.rand = mulberry32(options.seed);
  }

  /**
   * Genera una ráfaga de `count` envíos. El primero es siempre válido: sin un
   * pedido previo no hay duplicado posible, y arrancar con un duplicado
   * huérfano probaría otra cosa distinta de la que se quiere probar.
   */
  burst(count: number): SimulatedDelivery[] {
    const salida: SimulatedDelivery[] = [];
    for (let i = 0; i < count; i++) {
      const escenario = i === 0 ? 'valid' : elegirEscenario(this.rand());
      salida.push(this.build(escenario));
    }
    return salida;
  }

  /** Genera un envío de un escenario concreto (para pruebas dirigidas). */
  build(scenario: SimulatorScenario): SimulatedDelivery {
    const n = ++this.contador;
    const esDuplicado = scenario === 'duplicate' && this.emitidas.length > 0;

    const externalRef = esDuplicado
      ? this.emitidas[
          Math.floor(this.rand() * this.emitidas.length) % this.emitidas.length
        ]!
      : `SIM-${this.options.seed}-${n}`;

    if (!esDuplicado) this.emitidas.push(externalRef);

    const payload = this.payloadFor(scenario, externalRef, n);
    const rawBody =
      scenario === 'malformed'
        ? // Payload TRUNCADO: ni siquiera es JSON válido. Es el caso que de
          // verdad aparece cuando una conexión se corta a mitad de envío.
          JSON.stringify(payload).slice(0, 40)
        : JSON.stringify(payload);

    const secret =
      scenario === 'bad_signature'
        ? `${this.options.secret}-equivocado`
        : this.options.secret;

    return {
      scenario,
      // Un duplicado es un REENVÍO: mismo pedido, entrega distinta. Si
      // repitiera también el deliveryId, lo pararía el índice de la zona de
      // aterrizaje y no llegaría a probar el dedupe de pedidos, que es el que
      // importa.
      deliveryId: `DLV-${this.options.seed}-${n}`,
      externalRef,
      rawBody,
      headers: {
        'content-type': 'application/json',
        [DELIVERY_HEADER]: `DLV-${this.options.seed}-${n}`,
        [SIGNATURE_HEADER]: signSimulatorPayload(rawBody, secret),
      },
      expected:
        scenario === 'bad_signature'
          ? 'rejected'
          : scenario === 'unknown_sku' || scenario === 'malformed'
            ? 'needs_review'
            : 'order',
    };
  }

  private payloadFor(
    scenario: SimulatorScenario,
    externalRef: string,
    n: number,
  ): SimulatorPayload {
    const skus = this.options.knownSkus;
    const sku =
      scenario === 'unknown_sku'
        ? `SKU-INEXISTENTE-${n}`
        : skus[Math.floor(this.rand() * skus.length) % skus.length]!;

    const modificadores = this.options.knownModifierSkus ?? [];
    const opciones =
      scenario === 'unknown_sku' || modificadores.length === 0
        ? []
        : this.rand() < 0.4
          ? [modificadores[0]!]
          : [];

    const base: SimulatorPayload = {
      event: scenario === 'cancel' ? 'order.cancelled' : 'order.created',
      order_id: externalRef,
      placed_at: this.options.now.toISOString(),
      customer: {
        name: `Cliente Simulado ${n}`,
        phone: `+5199900${String(1000 + n).slice(-4)}`,
      },
      dropoff: this.options.dropoff
        ? {
            address: this.options.dropoff.address,
            latitude: this.options.dropoff.lat,
            longitude: this.options.dropoff.lng,
          }
        : null,
      items: [
        {
          sku,
          qty: 1 + Math.floor(this.rand() * 2),
          options: opciones,
        },
      ],
    };

    if (scenario === 'scheduled') {
      base.scheduled_for = new Date(
        this.options.now.getTime() + 3 * 60 * 60 * 1000,
      ).toISOString();
    }
    return base;
  }
}
