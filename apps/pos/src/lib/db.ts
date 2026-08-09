import type { CartaResuelta, PedidoOffline } from './api';
import type { SyncItem } from '@sahana/domain';

/**
 * Almacén local del POS: IndexedDB, sin biblioteca (ADR-0008, ADR-0019).
 *
 * Tres almacenes y ni uno más:
 *
 *  · `estado`  — sesión, dispositivo, marca elegida. Clave-valor.
 *  · `carta`   — el catálogo del canal `pos`, descargado entero.
 *  · `cola`    — las ventas pendientes de sincronizar.
 *
 * **Por qué IndexedDB y no `localStorage`.** `localStorage` es síncrono
 * —bloquea la interfaz mientras escribe, y el POS escribe al cerrar cada
 * venta—, tiene un límite de unos 5 MB que una carta con modificadores puede
 * rozar, y sobre todo **guarda cadenas**: cada venta obligaría a serializar y
 * reparsear la cola entera. Con veinte pedidos encolados en hora punta eso se
 * nota en el toque de «cobrar».
 *
 * **Por qué sin biblioteca.** La API de IndexedDB es fea pero pequeña, y lo que
 * se hace aquí son cuatro operaciones. Una dependencia más en el paquete que la
 * tablet descarga —y que hay que mantener— no se paga con eso.
 */

const NOMBRE = 'sahana-pos';
const VERSION = 1;

const ESTADO = 'estado';
const CARTA = 'carta';
const COLA = 'cola';

export interface EstadoDelDispositivo {
  deviceToken: string;
  deviceId: string;
  deviceName: string;
  locationId: string | null;
}

export interface EstadoDeSesion {
  accessToken: string;
  refreshToken: string;
  userId: string;
  userName: string;
  /** Instante (ms) en que caduca el token de acceso. */
  expiresAt: number;
}

function abrir(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NOMBRE, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ESTADO)) db.createObjectStore(ESTADO);
      if (!db.objectStoreNames.contains(CARTA)) db.createObjectStore(CARTA);
      if (!db.objectStoreNames.contains(COLA)) {
        // Clave = `clientId` (ULID). Es la clave natural del dedupe (ADR-0010):
        // encolar dos veces el mismo pedido —el cajero pulsa «cobrar» dos veces
        // porque la pantalla no respondió— sobrescribe, no duplica.
        db.createObjectStore(COLA, { keyPath: 'clientId' });
      }
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('No se pudo abrir el almacén local.'));
    };
  });
}

function esperar<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('Error de almacenamiento local.'));
    };
  });
}

async function leer<T>(store: string, clave: string): Promise<T | undefined> {
  const db = await abrir();
  try {
    const tx = db.transaction(store, 'readonly');
    return await esperar<T | undefined>(
      tx.objectStore(store).get(clave) as IDBRequest<T | undefined>,
    );
  } finally {
    db.close();
  }
}

async function escribir(
  store: string,
  clave: string,
  valor: unknown,
): Promise<void> {
  const db = await abrir();
  try {
    const tx = db.transaction(store, 'readwrite');
    await esperar(tx.objectStore(store).put(valor, clave));
  } finally {
    db.close();
  }
}

async function borrar(store: string, clave: string): Promise<void> {
  const db = await abrir();
  try {
    const tx = db.transaction(store, 'readwrite');
    await esperar(tx.objectStore(store).delete(clave));
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ Estado

export const almacen = {
  dispositivo: (): Promise<EstadoDelDispositivo | undefined> =>
    leer<EstadoDelDispositivo>(ESTADO, 'dispositivo'),
  guardarDispositivo: (d: EstadoDelDispositivo): Promise<void> =>
    escribir(ESTADO, 'dispositivo', d),
  olvidarDispositivo: (): Promise<void> => borrar(ESTADO, 'dispositivo'),

  sesion: (): Promise<EstadoDeSesion | undefined> =>
    leer<EstadoDeSesion>(ESTADO, 'sesion'),
  guardarSesion: (s: EstadoDeSesion): Promise<void> =>
    escribir(ESTADO, 'sesion', s),
  cerrarSesion: (): Promise<void> => borrar(ESTADO, 'sesion'),

  marca: (): Promise<string | undefined> => leer<string>(ESTADO, 'marca'),
  guardarMarca: (brandId: string): Promise<void> =>
    escribir(ESTADO, 'marca', brandId),

  // ------------------------------------------------------------- Carta

  /**
   * La carta guardada. **Es de la que se vende**, siempre — también con red.
   *
   * Vender de la descargada y no de una recién pedida no es un atajo: es lo que
   * hace que el comportamiento con red y sin red sea EL MISMO. Si con red se
   * vendiera de una respuesta fresca, el modo offline sería un camino distinto
   * que solo se ejercita cuando falla algo, y esos caminos siempre están rotos.
   */
  carta: (brandId: string): Promise<CartaResuelta | undefined> =>
    leer<CartaResuelta>(CARTA, brandId),
  guardarCarta: (brandId: string, carta: CartaResuelta): Promise<void> =>
    escribir(CARTA, brandId, carta),

  // -------------------------------------------------------------- Cola

  async cola(): Promise<Array<SyncItem<PedidoOffline>>> {
    const db = await abrir();
    try {
      const tx = db.transaction(COLA, 'readonly');
      return await esperar<Array<SyncItem<PedidoOffline>>>(
        tx.objectStore(COLA).getAll() as IDBRequest<
          Array<SyncItem<PedidoOffline>>
        >,
      );
    } finally {
      db.close();
    }
  },

  async guardarEnCola(item: SyncItem<PedidoOffline>): Promise<void> {
    const db = await abrir();
    try {
      const tx = db.transaction(COLA, 'readwrite');
      await esperar(tx.objectStore(COLA).put(item));
    } finally {
      db.close();
    }
  },

  /**
   * Vacía lo YA sincronizado. Se llama después de sincronizar, no antes: si se
   * borrara al enviar y la respuesta se perdiera, la venta desaparecería del
   * dispositivo sin estar en el servidor — y eso es perder dinero cobrado.
   */
  async purgarSincronizados(): Promise<number> {
    const db = await abrir();
    try {
      const tx = db.transaction(COLA, 'readwrite');
      const store = tx.objectStore(COLA);
      const todos = await esperar<Array<SyncItem<PedidoOffline>>>(
        store.getAll() as IDBRequest<Array<SyncItem<PedidoOffline>>>,
      );
      let borrados = 0;
      for (const item of todos) {
        if (item.status === 'synced') {
          await esperar(store.delete(item.clientId));
          borrados++;
        }
      }
      return borrados;
    } finally {
      db.close();
    }
  },
};
