import { describe, it, expect, vi, afterEach } from 'vitest';
import { impresion, ImpresionNoDisponible } from './impresion';
import type { LineaDeTicket } from './venta';

/**
 * Lo que se manda al agente de impresión.
 *
 * No se prueba que el papel salga —eso es del `print-agent`, que ya tiene sus
 * pruebas de ESC/POS— sino lo que la tablet le pide. Dos cosas concretas:
 * que el id del trabajo evite reimprimir de más, y que la comanda de cocina no
 * lleve precios.
 */

const CFG = {
  baseUrl: 'http://127.0.0.1:7443',
  token: 'token-de-agente',
  impresoraCocina: 'cocina',
  impresoraMostrador: 'mostrador',
};

const LINEA: LineaDeTicket = {
  key: 'l-1',
  productId: 'p-1',
  productName: 'Pollo a la brasa',
  quantity: 2,
  unitPriceMinor: 550_000,
  modifiers: [{ id: 'o-1', name: 'Ensalada', priceDeltaMinor: 30_000 }],
  allergens: ['mostaza', 'soya'],
};

function fingirAgente(): ReturnType<typeof vi.fn> {
  const espia = vi.fn(
    async () =>
      new Response(JSON.stringify({ jobId: 'x', status: 'pending' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', espia);
  return espia;
}

function cuerpoDe(
  espia: ReturnType<typeof vi.fn>,
  llamada = 0,
): Record<string, unknown> {
  const init = espia.mock.calls[llamada]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('Impresión desde el POS', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('la COMANDA no lleva precios', async () => {
    // La cocina no cobra, y un papel con importes en la zona de preparación es
    // una fuente de confusión y de reclamos.
    const espia = fingirAgente();
    await impresion.comanda(CFG, {
      ventaId: '01J0000000000000000000ABCD',
      orderNumber: 12,
      brandName: 'El Buen Sabor',
      stationName: 'Cocina',
      lines: [LINEA],
    });

    const cuerpo = cuerpoDe(espia);
    const lineas = cuerpo['lines'] as Array<Record<string, unknown>>;
    expect(lineas[0]).toMatchObject({
      quantity: 2,
      productName: 'Pollo a la brasa',
      modifiersText: 'Ensalada',
    });

    // Lo que esta prueba defiende es que NO VAN IMPORTES, así que se comprueba
    // eso y no la forma exacta del objeto. Con un `toEqual` cerrado, añadir un
    // campo legítimo —los alérgenos— la ponía en rojo sin que hubiera entrado
    // ni un precio, y una prueba que se rompe por lo que no vigila enseña a
    // «arreglarla» sin leerla.
    for (const clave of ['unitPrice', 'unitPriceMinor', 'lineTotal', 'total']) {
      expect(lineas[0]).not.toHaveProperty(clave);
    }
    expect(JSON.stringify(cuerpo)).not.toContain('S/');
  });

  it('COMANDA y PRECUENTA de la misma venta llevan ids DISTINTOS', async () => {
    // La cola del agente deduplica por id: con el mismo, la segunda impresión
    // se descartaría en silencio y el cliente se quedaría sin su precuenta.
    const espia = fingirAgente();
    const ventaId = '01J0000000000000000000WXYZ';
    await impresion.comanda(CFG, {
      ventaId,
      orderNumber: 12,
      brandName: 'El Buen Sabor',
      stationName: 'Cocina',
      lines: [LINEA],
    });
    await impresion.precuenta(CFG, {
      ventaId,
      orderNumber: 12,
      brandName: 'El Buen Sabor',
      locationName: 'Caja 1',
      lines: [LINEA],
    });

    expect(cuerpoDe(espia, 0)['jobId']).toBe(`${ventaId}-cocina`);
    expect(cuerpoDe(espia, 1)['jobId']).toBe(`${ventaId}-precuenta`);
  });

  it('la PRECUENTA desglosa el IGV hacia atrás: el precio ya lo incluye', async () => {
    // RN-T05: el precio del canal `pos` viene con IGV. Sumarlo otra vez
    // cobraría el impuesto dos veces; no desglosarlo dejaría la precuenta sin
    // el dato que la boleta sí lleva.
    const espia = fingirAgente();
    await impresion.precuenta(CFG, {
      ventaId: '01J0000000000000000000IGVX',
      orderNumber: 7,
      brandName: 'El Buen Sabor',
      locationName: 'Caja 1',
      // 2 × (55.00 + 3.00) = 116.00 con IGV incluido.
      lines: [LINEA],
    });

    const cuerpo = cuerpoDe(espia);
    expect(cuerpo['total']).toBe('S/ 116.00');
    expect(cuerpo['subtotal']).toBe('S/ 98.31');
    expect(cuerpo['tax']).toBe('S/ 17.69');
    expect(cuerpo['taxLabel']).toBe('IGV 18 %');

    // LO QUE IMPORTA: el papel SUMA. Base + IGV = total, siempre. Redondear
    // los tres por separado da 98.30 + 17.70 = 116.00 unas veces y 115.99
    // otras, y una precuenta que no cuadra es lo primero que el cliente
    // señala con el dedo.
    const aNumero = (v: unknown): number =>
      Number(String(v).replace('S/ ', ''));
    expect(aNumero(cuerpo['subtotal']) + aNumero(cuerpo['tax'])).toBeCloseTo(
      aNumero(cuerpo['total']),
      2,
    );
  });

  it('el agente apagado se dice en cristiano, no con un error de red', async () => {
    // «Failed to fetch» delante de un cliente no le sirve a nadie: hay que
    // decir dónde mirar.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(impresion.salud(CFG)).rejects.toBeInstanceOf(
      ImpresionNoDisponible,
    );
    await expect(impresion.salud(CFG)).rejects.toThrow(
      /computadora de la caja/i,
    );
  });

  it('LA COMANDA LLEVA LOS ALÉRGENOS al agente de impresión', async () => {
    // El papel es lo que el cocinero tiene en la mano en la mayoría de las
    // cocinas: que la pantalla del KDS los enseñe y el papel no, deja la mitad
    // del aviso donde nadie mira mientras se cocina.
    const agente = fingirAgente();
    await impresion.comanda(CFG, {
      ventaId: 'v-1',
      orderNumber: 47,
      brandName: 'Pollería',
      stationName: 'Parrilla',
      lines: [LINEA],
    });

    const cuerpo = JSON.parse(agente.mock.calls[0]![1].body as string) as {
      lines: Array<{ allergens?: string[] }>;
    };
    expect(cuerpo.lines[0]!.allergens).toEqual(['mostaza', 'soya']);
  });

  it('un plato SIN alérgenos no manda el campo vacío', async () => {
    // Una lista vacía haría que el agente imprimiera una advertencia en
    // blanco, y una advertencia que sale en cada línea se deja de leer.
    const agente = fingirAgente();
    await impresion.comanda(CFG, {
      ventaId: 'v-2',
      orderNumber: 48,
      brandName: 'Pollería',
      stationName: 'Parrilla',
      lines: [{ ...LINEA, allergens: [] }],
    });

    const cuerpo = JSON.parse(agente.mock.calls[0]![1].body as string) as {
      lines: Array<{ allergens?: string[] }>;
    };
    expect(cuerpo.lines[0]).not.toHaveProperty('allergens');
  });
});
