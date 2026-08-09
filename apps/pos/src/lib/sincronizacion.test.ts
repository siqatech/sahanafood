import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { almacen } from './db';
import { encolarVenta, pendientes, sincronizarUnaVez } from './sincronizacion';
import { api, SinRed, type PedidoOffline } from './api';

/**
 * La cola offline, contra un IndexedDB de verdad (`fake-indexeddb`).
 *
 * Es la parte del POS que puede perder dinero. Todo lo demás se rehace: una
 * pantalla mal alineada se corrige, un total mal sumado se detecta al
 * conciliar, pero **una venta cobrada que desaparece del dispositivo sin llegar
 * al servidor no se recupera de ninguna parte**.
 *
 * Por eso las pruebas de aquí no comprueban que la cola «funcione»: comprueban
 * que no pierda nada en los casos en que las cosas van mal — sin red, con el
 * servidor caído, con el navegador cerrado a mitad de envío.
 */

function pedido(n: number): PedidoOffline {
  return {
    clientId: `01J000000000000000000000${String(n).padStart(2, '0')}`,
    brandId: 'b-1',
    locationId: 'l-1',
    channel: 'pos',
    lines: [
      {
        productId: 'p-1',
        productName: 'Pollo',
        quantity: 1,
        unitPriceMinor: 550_000,
        lineTotalMinor: 550_000,
      },
    ],
    totalMinor: 550_000,
    soldAt: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    paymentMethod: 'cash',
  };
}

async function vaciar(): Promise<void> {
  // `fake-indexeddb/auto` da una base por proceso: se limpia entre pruebas para
  // que una no herede la cola de la anterior.
  for (const item of await almacen.cola()) {
    item.status = 'synced';
    await almacen.guardarEnCola(item);
  }
  await almacen.purgarSincronizados();
}

describe('Cola de ventas sin red', () => {
  beforeEach(async () => {
    await vaciar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('VEINTE VENTAS SIN RED se guardan y se sincronizan las veinte (T4.21)', async () => {
    // El criterio de aceptación literal del backlog. Es la prueba que justifica
    // que el POS sea una PWA con cola propia y no un cliente del servidor.
    for (let i = 0; i < 20; i++) await encolarVenta(pedido(i));
    expect(await pendientes()).toBe(20);

    const enviados: string[] = [];
    vi.spyOn(api, 'sincronizar').mockImplementation(async (_t, orders) => {
      enviados.push(...orders.map((o) => o.clientId));
      return {
        results: orders.map((o) => ({
          clientId: o.clientId,
          outcome: 'accepted',
        })),
        accepted: orders.length,
        duplicates: 0,
        failed: 0,
      };
    });

    // Varias vueltas: el lote va de 25, pero la cola no promete mandarlo todo
    // de una vez y el POS llama a esto de forma periódica.
    let resumen = await sincronizarUnaVez('token');
    while (resumen.pendientes > 0) resumen = await sincronizarUnaVez('token');

    expect(new Set(enviados).size).toBe(20);
    expect(await pendientes()).toBe(0);
  });

  it('van EN ORDEN DE VENTA, no en el que quiera la red', async () => {
    // Los números de pedido y el arqueo del turno se leen en el orden en que
    // ocurrieron las cosas.
    for (let i = 5; i >= 0; i--) await encolarVenta(pedido(i));

    let orden: string[] = [];
    vi.spyOn(api, 'sincronizar').mockImplementation(async (_t, orders) => {
      orden = orders.map((o) => o.clientId);
      return {
        results: orders.map((o) => ({
          clientId: o.clientId,
          outcome: 'accepted',
        })),
        accepted: orders.length,
        duplicates: 0,
        failed: 0,
      };
    });
    await sincronizarUnaVez('token');

    expect(orden).toEqual([...orden].sort());
  });

  it('SIN RED no se pierde nada y se reintenta después', async () => {
    await encolarVenta(pedido(1));
    // El reloj arranca DESPUÉS de la venta: un pedido no puede sincronizarse
    // antes de haberse vendido, y `nextAttemptAt` empieza en su hora de venta.
    const vendidoEn = Date.parse(pedido(1).soldAt);
    vi.spyOn(api, 'sincronizar').mockRejectedValue(new SinRed());

    const fallo = await sincronizarUnaVez('token', vendidoEn + 1_000);
    expect(fallo.sinRed).toBe(true);
    expect(fallo.pendientes).toBe(1);

    // El backoff impide reintentar de inmediato: sin él, una tarde sin internet
    // sería un bucle de peticiones que agota la batería de la tablet.
    const enseguida = await sincronizarUnaVez('token', vendidoEn + 1_100);
    expect(enseguida.enviados).toBe(0);

    // Pasado el backoff, entra.
    vi.restoreAllMocks();
    vi.spyOn(api, 'sincronizar').mockResolvedValue({
      results: [{ clientId: pedido(1).clientId, outcome: 'accepted' }],
      accepted: 1,
      duplicates: 0,
      failed: 0,
    });
    const luego = await sincronizarUnaVez('token', vendidoEn + 1_000_000);
    expect(luego.pendientes).toBe(0);
  });

  it('un pedido con AVISO entra y NO se reenvía (RN-T07)', async () => {
    // El servidor recalculó y el total no cuadra. La venta está hecha: el
    // cliente ya se fue. No se reintenta —crearía un duplicado— y no se borra
    // —alguien tiene que mirarlo—.
    await encolarVenta(pedido(2));
    vi.spyOn(api, 'sincronizar').mockResolvedValue({
      results: [
        {
          clientId: pedido(2).clientId,
          outcome: 'accepted',
          alerts: ['El total recalculado difiere en S/ 0.10'],
        },
      ],
      accepted: 1,
      duplicates: 0,
      failed: 0,
    });

    const resumen = await sincronizarUnaVez('token');
    expect(resumen.conAviso).toBe(1);

    const enCola = await almacen.cola();
    const item = enCola.find((i) => i.clientId === pedido(2).clientId);
    expect(item?.status).toBe('needs_attention');
    expect(item?.lastError).toContain('difiere');

    // Y una segunda vuelta NO lo reenvía.
    const segunda = await sincronizarUnaVez('token');
    expect(segunda.enviados).toBe(0);
  });

  it('lo que quedó EN VUELO al cerrar el navegador vuelve a la cola', async () => {
    // El caso real: la tablet se queda sin batería con una petición a medias.
    // Sin esto, esos pedidos se quedan marcados como enviándose para siempre,
    // sin sincronizar y sin que nadie lo note.
    await encolarVenta(pedido(3));
    const [item] = await almacen.cola();
    await almacen.guardarEnCola({ ...item!, status: 'in_flight' });

    vi.spyOn(api, 'sincronizar').mockResolvedValue({
      results: [{ clientId: pedido(3).clientId, outcome: 'duplicate' }],
      accepted: 0,
      duplicates: 1,
      failed: 0,
    });

    const resumen = await sincronizarUnaVez('token');
    expect(resumen.enviados).toBe(1);
    expect(resumen.pendientes).toBe(0);
  });

  it('encolar DOS VECES el mismo pedido no lo duplica', async () => {
    // Pasa de verdad: el cajero pulsa «cobrar» dos veces porque la pantalla no
    // respondió. Duplicar aquí sería duplicar la venta.
    await encolarVenta(pedido(4));
    await encolarVenta(pedido(4));
    expect(await pendientes()).toBe(1);
  });

  it('un pedido SOLO se borra del dispositivo tras confirmarse', async () => {
    // Borrar al enviar y perder la respuesta haría desaparecer del dispositivo
    // una venta que no está en el servidor: dinero cobrado y no registrado.
    await encolarVenta(pedido(6));
    vi.spyOn(api, 'sincronizar').mockRejectedValue(new Error('500'));
    await sincronizarUnaVez('token');

    const enCola = await almacen.cola();
    expect(enCola.some((i) => i.clientId === pedido(6).clientId)).toBe(true);
  });
});
