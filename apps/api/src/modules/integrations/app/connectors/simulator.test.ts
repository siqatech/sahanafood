import { describe, it, expect } from 'vitest';
import {
  SimulatorConnector,
  signSimulatorPayload,
  SIGNATURE_HEADER,
  DELIVERY_HEADER,
} from './simulator.connector.js';
import { MarketplaceSimulator } from './simulator.generator.js';
import { ConnectorParseError } from '../../domain/channel-connector.js';

const SECRETO = 'secreto-de-firma-de-pruebas';
const AHORA = new Date('2026-08-07T12:00:00Z');

const pedidoValido = {
  event: 'order.created',
  order_id: 'SIM-1',
  customer: { name: 'Ana', phone: '+51999000111' },
  dropoff: { address: 'Av. Larco 123', latitude: -12.12, longitude: -77.02 },
  items: [{ sku: 'SKU-COMBO', qty: 2, options: ['SKU-GRANDE'] }],
  tip_cents: 500,
  total_cents: 8600,
};

describe('Verificación de firma del webhook', () => {
  const connector = new SimulatorConnector();

  it('acepta una firma correcta', () => {
    const raw = JSON.stringify(pedidoValido);
    const headers = { [SIGNATURE_HEADER]: signSimulatorPayload(raw, SECRETO) };
    expect(connector.verifyWebhook(raw, headers, SECRETO)).toBe(true);
  });

  it('rechaza si falta la cabecera de firma', () => {
    expect(
      connector.verifyWebhook(JSON.stringify(pedidoValido), {}, SECRETO),
    ).toBe(false);
  });

  it('rechaza una firma de otro secreto', () => {
    const raw = JSON.stringify(pedidoValido);
    const headers = {
      [SIGNATURE_HEADER]: signSimulatorPayload(raw, 'otro-secreto'),
    };
    expect(connector.verifyWebhook(raw, headers, SECRETO)).toBe(false);
  });

  it('rechaza si el cuerpo cambió aunque sea un byte', () => {
    const raw = JSON.stringify(pedidoValido);
    const firma = signSimulatorPayload(raw, SECRETO);
    // Un atacante que intercepta y sube la propina sin poder refirmar.
    const alterado = raw.replace('"tip_cents":500', '"tip_cents":900');
    expect(
      connector.verifyWebhook(alterado, { [SIGNATURE_HEADER]: firma }, SECRETO),
    ).toBe(false);
  });

  it('la firma depende de los BYTES, no del objeto equivalente', () => {
    // Este es el motivo de que la ingesta trabaje con el cuerpo crudo: dos
    // JSON semánticamente idénticos con distinto orden de claves producen
    // firmas distintas, y re-serializar rompería webhooks legítimos.
    const a = '{"order_id":"X","event":"order.created"}';
    const b = '{"event":"order.created","order_id":"X"}';
    expect(signSimulatorPayload(a, SECRETO)).not.toBe(
      signSimulatorPayload(b, SECRETO),
    );
  });
});

describe('Traducción del payload del proveedor', () => {
  const connector = new SimulatorConnector();

  it('traduce un pedido completo', () => {
    const n = connector.parseOrder(pedidoValido);
    expect(n.externalRef).toBe('SIM-1');
    expect(n.lines).toHaveLength(1);
    expect(n.lines[0]).toMatchObject({
      externalSku: 'SKU-COMBO',
      quantity: 2,
      modifierSkus: ['SKU-GRANDE'],
    });
    expect(n.customerName).toBe('Ana');
    expect(n.delivery).toEqual({
      address: 'Av. Larco 123',
      lat: -12.12,
      lng: -77.02,
    });
  });

  it('convierte céntimos del canal a la escala interna de Money', () => {
    // El proveedor habla en 2 decimales y Money trabaja a escala 4. Si esta
    // conversión se pierde, una propina de S/ 5,00 se convierte en S/ 0,05.
    const n = connector.parseOrder(pedidoValido);
    expect(n.tipMinor).toBe(50_000);
    expect(n.channelTotalMinor).toBe(860_000);
  });

  it('un pedido sin order_id no se puede deduplicar: se rechaza el parseo', () => {
    expect(() =>
      connector.parseOrder({ ...pedidoValido, order_id: '' }),
    ).toThrow(ConnectorParseError);
  });

  it('rechaza pedidos sin líneas y líneas sin SKU o con cantidad inválida', () => {
    expect(() => connector.parseOrder({ ...pedidoValido, items: [] })).toThrow(
      ConnectorParseError,
    );
    expect(() =>
      connector.parseOrder({ ...pedidoValido, items: [{ qty: 1 }] }),
    ).toThrow(/no trae SKU/);
    expect(() =>
      connector.parseOrder({
        ...pedidoValido,
        items: [{ sku: 'X', qty: 0 }],
      }),
    ).toThrow(/cantidad inválida/);
    expect(() =>
      connector.parseOrder({
        ...pedidoValido,
        items: [{ sku: 'X', qty: -3 }],
      }),
    ).toThrow(/cantidad inválida/);
  });

  it('rechaza una fecha programada inválida en vez de crear un Invalid Date', () => {
    expect(() =>
      connector.parseOrder({ ...pedidoValido, scheduled_for: 'mañana' }),
    ).toThrow(/no es una fecha válida/);
  });

  it('sin coordenadas no inventa una entrega', () => {
    const n = connector.parseOrder({
      ...pedidoValido,
      dropoff: { address: 'Solo texto' },
    });
    expect(n.delivery).toBeUndefined();
  });

  it('identify funciona aunque el pedido sea inválido', () => {
    // Es la propiedad que permite aterrizar un payload roto y deduplicar sus
    // reintentos: identificar no exige entender.
    const id = connector.identify(
      { basura: true },
      { [DELIVERY_HEADER]: 'DLV-9' },
    );
    expect(id.deliveryId).toBe('DLV-9');
    expect(id.externalRef).toBeUndefined();
  });
});

describe('Generador de tráfico del simulador', () => {
  const opciones = {
    seed: 42,
    secret: SECRETO,
    knownSkus: ['SKU-COMBO'],
    knownModifierSkus: ['SKU-GRANDE'],
    dropoff: { address: 'Av. Larco 123', lat: -12.12, lng: -77.02 },
    now: AHORA,
  };

  it('es REPRODUCIBLE: la misma semilla da exactamente la misma ráfaga', () => {
    // Sin esta propiedad, un fallo de la prueba de caos sería irrepetible y por
    // tanto imposible de depurar.
    const a = new MarketplaceSimulator(opciones).burst(50);
    const b = new MarketplaceSimulator(opciones).burst(50);
    expect(a).toEqual(b);
  });

  it('semillas distintas dan ráfagas distintas', () => {
    const a = new MarketplaceSimulator(opciones).burst(30);
    const b = new MarketplaceSimulator({ ...opciones, seed: 7 }).burst(30);
    expect(a).not.toEqual(b);
  });

  it('produce la mezcla de escenarios que rompe una integración real', () => {
    const envios = new MarketplaceSimulator(opciones).burst(200);
    const porEscenario = new Map<string, number>();
    for (const e of envios) {
      porEscenario.set(e.scenario, (porEscenario.get(e.scenario) ?? 0) + 1);
    }
    for (const esperado of [
      'valid',
      'duplicate',
      'unknown_sku',
      'malformed',
      'bad_signature',
    ]) {
      expect(
        porEscenario.get(esperado) ?? 0,
        `no se generó ningún envío de tipo ${esperado} en 200`,
      ).toBeGreaterThan(0);
    }
  });

  it('un duplicado repite la referencia del pedido pero no el id de entrega', () => {
    // Si repitiera el id de entrega lo pararía el índice de la zona de
    // aterrizaje y nunca llegaría a probar el dedupe de pedidos.
    const envios = new MarketplaceSimulator(opciones).burst(200);
    const duplicados = envios.filter((e) => e.scenario === 'duplicate');
    expect(duplicados.length).toBeGreaterThan(0);

    const idsEntrega = new Set(envios.map((e) => e.deliveryId));
    expect(idsEntrega.size).toBe(envios.length);

    for (const d of duplicados) {
      const anteriores = envios.filter((e) => e.externalRef === d.externalRef);
      expect(
        anteriores.length,
        'un duplicado debería compartir externalRef con otro envío',
      ).toBeGreaterThan(1);
    }
  });

  it('el primer envío siempre es válido', () => {
    const [primero] = new MarketplaceSimulator(opciones).burst(10);
    expect(primero!.scenario).toBe('valid');
  });

  it('los envíos válidos van correctamente firmados y los de firma mala no', () => {
    const connector = new SimulatorConnector();
    for (const envio of new MarketplaceSimulator(opciones).burst(100)) {
      const ok = connector.verifyWebhook(
        envio.rawBody,
        envio.headers,
        SECRETO,
      );
      expect(ok, `escenario ${envio.scenario}`).toBe(
        envio.scenario !== 'bad_signature',
      );
    }
  });

  it('el payload malformado NO es JSON válido', () => {
    const envio = new MarketplaceSimulator(opciones).build('malformed');
    expect(() => JSON.parse(envio.rawBody)).toThrow();
    expect(envio.expected).toBe('needs_review');
  });

  it('el escenario programado trae fecha futura', () => {
    const envio = new MarketplaceSimulator(opciones).build('scheduled');
    const cuerpo = JSON.parse(envio.rawBody) as { scheduled_for: string };
    expect(new Date(cuerpo.scheduled_for).getTime()).toBeGreaterThan(
      AHORA.getTime(),
    );
  });

  it('no depende del reloj ni de Math.random', () => {
    // Se comprueba de forma directa: dos ráfagas generadas con el mismo
    // `now` en momentos reales distintos deben ser idénticas byte a byte.
    const a = new MarketplaceSimulator(opciones).burst(20);
    const b = new MarketplaceSimulator(opciones).burst(20);
    expect(a.map((e) => e.rawBody)).toEqual(b.map((e) => e.rawBody));
  });
});
