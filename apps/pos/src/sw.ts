/// <reference lib="webworker" />

/**
 * Service worker del POS (ADR-0019).
 *
 * Su único trabajo es que **la aplicación arranque sin red**. Nada más: no
 * cachea respuestas de la API ni intenta ser listo con los datos. Esa
 * tentación es justo la que produce el fallo más caro de un POS — servir una
 * carta vieja creyendo que es la de hoy — y aquí no hace falta, porque la carta
 * la guarda la propia aplicación en IndexedDB, con su fecha de descarga a la
 * vista.
 *
 * Estrategia: **precarga al instalar, y luego caché primero** para los archivos
 * propios. Una tablet que arranca sin internet tiene que pintar la pantalla de
 * venta, y para eso el HTML, el JavaScript y el CSS tienen que estar en disco
 * antes de que se corte la red, no en el momento en que se corta.
 */

declare const self: ServiceWorkerGlobalScope;

/**
 * Lo que hay que precargar, inyectado por la compilación.
 *
 * `import.meta.env` lo resuelve Vite en tiempo de compilación; en desarrollo no
 * hay manifiesto y la lista queda vacía, que es lo correcto: en desarrollo el
 * service worker estorbaría más de lo que ayuda.
 */
const VERSION = (import.meta.env['VITE_SW_VERSION'] as string) || 'dev';
const CACHE = `sahana-pos-${VERSION}`;

/** El casco mínimo: sin esto la aplicación no arranca. */
const CASCO = ['/', '/index.html', '/manifest.webmanifest', '/icono.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` fuerza a saltarse la caché HTTP del navegador: si no, una
      // instalación podría precargar la versión anterior desde la caché del
      // propio navegador y quedarse ahí para siempre.
      await cache.addAll(
        CASCO.map((url) => new Request(url, { cache: 'reload' })),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Fuera las cachés de versiones anteriores. Sin esto, cada despliegue deja
      // una copia entera de la aplicación en la tablet, y una tablet de local se
      // queda sin espacio en un año.
      for (const nombre of await caches.keys()) {
        if (nombre.startsWith('sahana-pos-') && nombre !== CACHE) {
          await caches.delete(nombre);
        }
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Solo lo NUESTRO y del mismo origen. La API va siempre a la red: una
  // respuesta de la API servida desde caché sería una carta o una cola de
  // cocina viejas presentadas como actuales.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);

      // Navegación: primero la red, con la caché como red de seguridad. Así una
      // tablet con internet siempre estrena versión, y sin internet arranca.
      if (req.mode === 'navigate') {
        try {
          const respuesta = await fetch(req);
          await cache.put('/index.html', respuesta.clone());
          return respuesta;
        } catch {
          const guardada = await cache.match('/index.html');
          if (guardada) return guardada;
          throw new Error('Sin conexión y sin copia local.');
        }
      }

      // Recursos con hash en el nombre: caché primero. Si el nombre cambió, no
      // estará en caché y se pedirá; si no cambió, no hace falta pedirlo.
      const guardada = await cache.match(req);
      if (guardada) return guardada;

      const respuesta = await fetch(req);
      if (respuesta.ok) await cache.put(req, respuesta.clone());
      return respuesta;
    })(),
  );
});

export {};
