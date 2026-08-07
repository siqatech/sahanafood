import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Descubrimiento de impresoras en la red del local (docs/26 §3).
 *
 * El asistente de instalación pregunta «¿dónde está la impresora?» y la
 * respuesta honesta de quien monta el local es «no sé». La IP de una térmica
 * no está escrita en ninguna parte: hay que sacarla del propio menú de la
 * impresora imprimiendo una página de configuración, y eso ya es pedir
 * demasiado. Escanear la red y ofrecer una lista es la diferencia entre una
 * instalación de cinco minutos y una llamada a soporte.
 *
 * El escaneo es deliberadamente tonto: abre el puerto 9100 en cada dirección
 * de la /24 y anota quién contesta. No hay descubrimiento estándar que
 * funcione en las térmicas genéricas del mercado peruano (docs/26): SNMP está
 * a medias y mDNS casi nunca. Un TCP connect sí lo soportan todas, porque es
 * exactamente por donde reciben los tickets.
 */

export interface DiscoveredPrinter {
  host: string;
  port: number;
}

export interface ScanOptions {
  /** Primeros tres octetos, p. ej. `192.168.1`. */
  prefix: string;
  port?: number;
  /** Corto a propósito: son 254 intentos y alguien está esperando. */
  timeoutMs?: number;
  /** Cuántas direcciones a la vez. */
  concurrency?: number;
  /** Rango de último octeto, para poder acotarlo en pruebas. */
  from?: number;
  to?: number;
}

/** ¿Hay algo escuchando? Un connect que abre es todo lo que se necesita. */
function responde(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let resuelto = false;
    const terminar = (ok: boolean): void => {
      if (resuelto) return;
      resuelto = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => terminar(true));
    socket.on('timeout', () => terminar(false));
    socket.on('error', () => terminar(false));
  });
}

/**
 * Recorre el rango con un número acotado de sondas simultáneas.
 *
 * Sin el tope, 254 sockets a la vez agotan los descriptores de una mini PC
 * modesta —que es justo el hardware recomendado (docs/26)— y el escaneo
 * devuelve falsos negativos: la impresora está ahí, pero no quedaban sockets
 * para preguntarle.
 */
export async function scanForPrinters(
  options: ScanOptions,
): Promise<DiscoveredPrinter[]> {
  const port = options.port ?? 9100;
  const timeoutMs = options.timeoutMs ?? 300;
  const concurrency = Math.max(1, options.concurrency ?? 32);
  const desde = options.from ?? 1;
  const hasta = options.to ?? 254;

  const direcciones: string[] = [];
  for (let i = desde; i <= hasta; i++)
    direcciones.push(`${options.prefix}.${i}`);

  const encontradas: DiscoveredPrinter[] = [];
  let siguiente = 0;

  const trabajador = async (): Promise<void> => {
    while (siguiente < direcciones.length) {
      const host = direcciones[siguiente++]!;
      if (await responde(host, port, timeoutMs)) {
        encontradas.push({ host, port });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, direcciones.length) }, () =>
      trabajador(),
    ),
  );

  // El orden de llegada depende de quién conteste antes; ordenar por octeto
  // hace que la lista del asistente no baile entre escaneos.
  return encontradas.sort(
    (a, b) => Number(a.host.split('.')[3]) - Number(b.host.split('.')[3]),
  );
}

/**
 * Prefijos /24 de las redes locales de esta máquina.
 *
 * Se descartan las interfaces internas y las que no son IPv4: escanear
 * `127.0.0.x` no encuentra impresoras, y una mini PC suele traer también una
 * interfaz virtual de Docker o del VPN que no lleva a ninguna parte.
 */
export function localPrefixes(interfaces = networkInterfaces()): string[] {
  const prefijos = new Set<string>();
  for (const direcciones of Object.values(interfaces)) {
    for (const dir of direcciones ?? []) {
      if (dir.family !== 'IPv4' || dir.internal) continue;
      prefijos.add(dir.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...prefijos];
}
