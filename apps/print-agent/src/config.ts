import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  NetworkPrinter,
  FilePrinter,
  type PrinterTransport,
} from './transport/printer.js';

/**
 * Configuración del agente, toda por variables de entorno.
 *
 * Quien instala esto es la persona que monta el local, no un desarrollador: un
 * fichero de configuración con formato propio sería una fuente de errores más.
 * Las variables las escribe el instalador una sola vez y quedan en el servicio.
 *
 * Vive separado de `main.ts` para que el diagnóstico (`doctor`) pueda leer la
 * MISMA configuración que usará el servicio. Un diagnóstico que valida algo
 * distinto de lo que arranca no diagnostica nada.
 */

export const PUERTO_POR_DEFECTO = 7443;
export const ANCHO_POR_DEFECTO = 48;

export interface PrinterSpec {
  name: string;
  /** Cómo está conectada, en el mismo formato que la escribió el instalador. */
  target: string;
  transport: PrinterTransport;
}

/**
 * Interpreta `PRINTERS`: `nombre=tipo:destino`, separados por coma.
 *
 *   cocina=net:192.168.1.50:9100,caja=file:/dev/usb/lp0
 */
export function parsePrinters(spec: string): PrinterSpec[] {
  const impresoras: PrinterSpec[] = [];
  const vistos = new Set<string>();

  for (const entrada of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [nombre, ...resto] = entrada.split('=');
    const destino = resto.join('=');
    if (!nombre || !destino) {
      throw new Error(
        `Configuración de impresora inválida: "${entrada}". Formato: nombre=net:host:puerto o nombre=file:/ruta`,
      );
    }

    // Dos impresoras con el mismo nombre: la segunda pisaría a la primera en
    // silencio y las comandas de una estación acabarían saliendo por la otra.
    if (vistos.has(nombre)) {
      throw new Error(
        `La impresora "${nombre}" está configurada dos veces. Cada nombre debe ser único.`,
      );
    }
    vistos.add(nombre);

    if (destino.startsWith('net:')) {
      const [, host, puerto] = destino.split(':');
      if (!host) throw new Error(`Falta el host en "${entrada}".`);
      const puertoNum = puerto ? Number(puerto) : 9100;
      if (!Number.isInteger(puertoNum) || puertoNum < 1 || puertoNum > 65535) {
        throw new Error(
          `Puerto inválido en "${entrada}": ${puerto}. Las térmicas de red suelen usar 9100.`,
        );
      }
      impresoras.push({
        name: nombre,
        target: destino,
        transport: new NetworkPrinter(nombre, host, puertoNum),
      });
    } else if (destino.startsWith('file:')) {
      const ruta = destino.slice('file:'.length);
      if (!ruta) throw new Error(`Falta la ruta en "${entrada}".`);
      impresoras.push({
        name: nombre,
        target: destino,
        transport: new FilePrinter(nombre, ruta),
      });
    } else {
      throw new Error(
        `Tipo de impresora desconocido en "${entrada}". Usa net: o file:.`,
      );
    }
  }

  if (impresoras.length === 0) {
    throw new Error(
      'No hay ninguna impresora configurada en PRINTERS. Sin impresoras el agente no sirve para nada.',
    );
  }

  return impresoras;
}

export interface AgentConfig {
  token: string;
  printers: PrinterSpec[];
  queueFile: string;
  port: number;
  ticketWidth: number;
}

/** Lee y valida el entorno. Lanza con un mensaje que pueda leer un instalador. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const token = env.AGENT_TOKEN;
  if (!token || token.length < 16) {
    // Sin token, cualquier pestaña abierta en el mismo navegador podría
    // imprimir en la cocina. Es una condición de arranque, no un aviso.
    throw new Error(
      'Falta AGENT_TOKEN (mínimo 16 caracteres). Empareja la caja desde el panel para obtenerlo.',
    );
  }

  const puerto = env.AGENT_PORT ? Number(env.AGENT_PORT) : PUERTO_POR_DEFECTO;
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
    throw new Error(`AGENT_PORT inválido: ${env.AGENT_PORT}`);
  }

  const ancho = env.TICKET_WIDTH ? Number(env.TICKET_WIDTH) : ANCHO_POR_DEFECTO;
  // 32 en papel de 58 mm, 48 en el de 80 mm. Un valor fuera de rango parte
  // todas las líneas y no se nota hasta que sale la primera comanda.
  if (!Number.isInteger(ancho) || ancho < 24 || ancho > 96) {
    throw new Error(
      `TICKET_WIDTH inválido: ${env.TICKET_WIDTH}. Usa 32 para papel de 58 mm o 48 para el de 80 mm.`,
    );
  }

  return {
    token,
    printers: parsePrinters(env.PRINTERS ?? 'cocina=file:./salida/cocina.bin'),
    queueFile: env.QUEUE_FILE ?? join(homedir(), '.sahana', 'print-queue.json'),
    port: puerto,
    ticketWidth: ancho,
  };
}

/** Mapa nombre→transporte, que es lo que consume el despachador. */
export function transportMap(
  printers: PrinterSpec[],
): Map<string, PrinterTransport> {
  return new Map(printers.map((p) => [p.name, p.transport]));
}
