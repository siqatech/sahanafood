import {
  SERVICE_WINDOW_HOURS,
  type ContactState,
} from '../messaging/whatsapp-window.js';

/**
 * Cuenta regresiva de la ventana de 24 h (RN-CNV-03, T5.20).
 *
 * `decideSend` ya responde «¿puedo escribir libre?». Esto responde la otra
 * mitad, la que necesita una PERSONA delante de la bandeja: **cuánto queda**.
 *
 * La regla de la spec es explícita y va contra lo cómodo: *«expirada, la UI
 * solo permite plantillas aprobadas y lo indica; **no deja escribir libre y
 * fallar**»*. Dejar escribir y que Meta descarte el mensaje en silencio es el
 * peor de los dos mundos: el agente cree que contestó, el cliente no recibe
 * nada y nadie se entera hasta que el cliente reclama.
 *
 * Se calcula en el dominio y no en el navegador porque el reloj del navegador
 * no es de fiar —zona horaria mal puesta, portátil dormido— y aquí lo que hay
 * en juego es si un mensaje sale o se pierde.
 */

export type WindowState =
  /** Se puede escribir texto libre. */
  | 'open'
  /** Abierta pero queda poco: el agente debería cerrar ya. */
  | 'closing'
  /** Cerrada: SOLO plantillas. */
  | 'expired'
  /** El contacto nunca escribió: no hay ventana que abrir. */
  | 'never_opened';

export interface WindowCountdown {
  state: WindowState;
  /** Minutos que quedan. 0 si está cerrada o nunca se abrió. */
  minutesRemaining: number;
  /** Cuándo se cierra. `null` si no hay ventana. */
  expiresAt: Date | null;
  /** true SOLO si se puede mandar texto libre ahora mismo. */
  canSendFreeform: boolean;
  /** Qué enseñar en la bandeja, ya redactado. */
  label: string;
}

/**
 * Umbral de aviso.
 *
 * Una hora y no diez minutos: el agente tiene que poder terminar la
 * conversación, no enterarse cuando ya no llega. En una bandeja con varias
 * conversaciones abiertas, diez minutos es tiempo de leer el aviso y nada más.
 */
export const CLOSING_SOON_MINUTES = 60;

export function windowCountdown(
  contacto: ContactState,
  now: Date,
  windowHours = SERVICE_WINDOW_HOURS,
): WindowCountdown {
  if (!contacto.lastInboundAt) {
    return {
      state: 'never_opened',
      minutesRemaining: 0,
      expiresAt: null,
      canSendFreeform: false,
      label:
        'Este contacto nunca ha escrito: solo se puede iniciar con plantilla.',
    };
  }

  const expiresAt = new Date(
    contacto.lastInboundAt.getTime() + windowHours * 3_600_000,
  );
  const restanMs = expiresAt.getTime() - now.getTime();

  if (restanMs <= 0) {
    return {
      state: 'expired',
      minutesRemaining: 0,
      expiresAt,
      canSendFreeform: false,
      label:
        'La ventana de 24 h se cerró: solo se puede responder con una plantilla aprobada.',
    };
  }

  // Se redondea hacia ARRIBA: con 30 s restantes, «queda 1 min» es cierto y
  // «quedan 0 min» diría que ya no se puede cuando todavía sí.
  const minutesRemaining = Math.ceil(restanMs / 60_000);

  if (minutesRemaining <= CLOSING_SOON_MINUTES) {
    return {
      state: 'closing',
      minutesRemaining,
      expiresAt,
      canSendFreeform: true,
      label: `Quedan ${minutesRemaining} min de ventana: después solo plantillas.`,
    };
  }

  const horas = Math.floor(minutesRemaining / 60);
  const minutos = minutesRemaining % 60;
  return {
    state: 'open',
    minutesRemaining,
    expiresAt,
    canSendFreeform: true,
    label:
      minutos === 0
        ? `Ventana abierta: quedan ${horas} h.`
        : `Ventana abierta: quedan ${horas} h ${minutos} min.`,
  };
}
