import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './estilos.css';

/**
 * Arranque de la PWA.
 *
 * El service worker se registra **después** de que la aplicación pinte: si se
 * registrara antes, la primera carga en una tablet lenta esperaría a la
 * instalación para enseñar algo, y la primera impresión de un POS es que
 * arranque rápido.
 */
const raiz = document.getElementById('raiz');
if (raiz) {
  createRoot(raiz).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sin service worker la aplicación funciona con red. Fallar aquí NO puede
      // impedir vender: se registra en la próxima carga.
    });
  });
}
