import { createConnection } from 'node:net';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Transportes hacia la impresora.
 *
 * La interfaz es deliberadamente mínima —«manda estos bytes»— porque es lo
 * único que ESC/POS necesita y porque así el despachador y la cola se pueden
 * probar enteros sin ninguna impresora delante.
 */
export interface PrinterTransport {
  readonly name: string;
  send(payload: Buffer): Promise<void>;
  /** ¿Responde? Lo consulta el reporte de salud. */
  probe(): Promise<boolean>;
}

/**
 * Impresora de red (ESC/POS crudo sobre TCP 9100).
 *
 * Es el transporte que se usa en producción: casi todas las térmicas con
 * ethernet o wifi exponen el puerto 9100 y aceptan los bytes tal cual.
 *
 * El timeout es corto y explícito: una impresora apagada NO rechaza la
 * conexión, la deja colgada. Sin timeout, el despachador se quedaría esperando
 * para siempre con la comanda en la mano y la cola detenida detrás.
 */
export class NetworkPrinter implements PrinterTransport {
  constructor(
    readonly name: string,
    private readonly host: string,
    private readonly port = 9100,
    private readonly timeoutMs = 5_000,
  ) {}

  send(payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      socket.setTimeout(this.timeoutMs);

      const fallar = (error: Error): void => {
        socket.destroy();
        reject(error);
      };

      socket.on('timeout', () =>
        fallar(
          new Error(
            `La impresora ${this.name} (${this.host}:${this.port}) no respondió en ${this.timeoutMs} ms. ¿Está encendida?`,
          ),
        ),
      );
      socket.on('error', (error) => fallar(error));
      socket.on('connect', () => {
        socket.write(payload, (error) => {
          if (error) return fallar(error);
          // `end` espera a que el búfer se vacíe: cerrar antes cortaría el
          // ticket a mitad sin que nada diera error.
          socket.end(() => resolve());
        });
      });
    });
  }

  probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host: this.host, port: this.port });
      socket.setTimeout(this.timeoutMs);
      const cerrar = (ok: boolean): void => {
        socket.destroy();
        resolve(ok);
      };
      socket.on('connect', () => cerrar(true));
      socket.on('timeout', () => cerrar(false));
      socket.on('error', () => cerrar(false));
    });
  }
}

/**
 * Impresora a fichero.
 *
 * No es un juguete de pruebas: en un local con una impresora compartida por
 * USB, el camino habitual en Linux es escribir al dispositivo de carácter
 * (`/dev/usb/lp0`), que desde Node es exactamente esto. Y en desarrollo
 * permite ver el ticket sin gastar papel.
 */
export class FilePrinter implements PrinterTransport {
  constructor(
    readonly name: string,
    private readonly path: string,
  ) {}

  async send(payload: Buffer): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, payload);
  }

  async probe(): Promise<boolean> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Transporte que siempre falla. Se usa cuando una impresora está configurada
 * pero su driver no está disponible (USB nativo, por ejemplo): mejor un
 * trabajo en la cola con un error claro que un agente que no arranca.
 */
export class UnavailablePrinter implements PrinterTransport {
  constructor(
    readonly name: string,
    private readonly motivo: string,
  ) {}

  send(): Promise<void> {
    return Promise.reject(
      new Error(`La impresora ${this.name} no está disponible: ${this.motivo}`),
    );
  }

  probe(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
