import { join } from 'node:path';
import { homedir } from 'node:os';
import { PrintQueue } from './queue/print-queue.js';
import { PrintDispatcher } from './queue/dispatcher.js';
import {
  NetworkPrinter,
  FilePrinter,
  type PrinterTransport,
} from './transport/printer.js';
import { createAgentServer } from './api/server.js';

/**
 * Punto de entrada del agente de impresión (ADR-0008).
 *
 * Se instala en una máquina del local y corre como servicio. Todo lo que
 * necesita saber viene de variables de entorno, porque quien lo instala es la
 * persona que monta el local, no un desarrollador: un fichero de configuración
 * con formato propio sería una fuente de errores más.
 *
 * Formato de PRINTERS: `nombre=tipo:destino`, separados por coma.
 *   cocina=net:192.168.1.50:9100,caja=file:/dev/usb/lp0
 */

function parsePrinters(spec: string): Map<string, PrinterTransport> {
  const impresoras = new Map<string, PrinterTransport>();

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

    if (destino.startsWith('net:')) {
      const [, host, puerto] = destino.split(':');
      if (!host) throw new Error(`Falta el host en "${entrada}".`);
      impresoras.set(
        nombre,
        new NetworkPrinter(nombre, host, puerto ? Number(puerto) : 9100),
      );
    } else if (destino.startsWith('file:')) {
      impresoras.set(
        nombre,
        new FilePrinter(nombre, destino.slice('file:'.length)),
      );
    } else {
      throw new Error(
        `Tipo de impresora desconocido en "${entrada}". Usa net: o file:.`,
      );
    }
  }

  return impresoras;
}

async function bootstrap(): Promise<void> {
  const token = process.env.AGENT_TOKEN;
  if (!token || token.length < 16) {
    // Sin token, cualquier pestaña abierta en el mismo navegador podría
    // imprimir en la cocina. Es una condición de arranque, no un aviso.
    throw new Error(
      'Falta AGENT_TOKEN (mínimo 16 caracteres). Empareja la caja desde el panel para obtenerlo.',
    );
  }

  const impresoras = parsePrinters(
    process.env.PRINTERS ?? 'cocina=file:./salida/cocina.bin',
  );
  const rutaCola =
    process.env.QUEUE_FILE ?? join(homedir(), '.sahana', 'print-queue.json');

  const cola = new PrintQueue({ filePath: rutaCola });
  const recuperados = await cola.load();
  if (recuperados > 0) {
    // Es la línea que explica por qué salen tickets solos al arrancar tras un
    // corte de luz. Sin ella, parecería un fantasma.
    console.log(
      `Cola recuperada del disco: ${recuperados} trabajos, ${cola.pendingCount()} pendientes de imprimir.`,
    );
  }

  const despachador = new PrintDispatcher(cola, impresoras);
  const puerto = Number(process.env.AGENT_PORT ?? 7443);

  const servidor = createAgentServer({
    queue: cola,
    dispatcher: despachador,
    pairingToken: token,
    ...(process.env.TICKET_WIDTH
      ? { ticketWidth: Number(process.env.TICKET_WIDTH) }
      : {}),
  });

  // SOLO localhost: un agente en 0.0.0.0 deja que cualquier teléfono del wifi
  // del local imprima en la cocina.
  servidor.listen(puerto, '127.0.0.1', () => {
    console.log(
      `Agente de impresión escuchando en http://127.0.0.1:${puerto} — impresoras: ${[...impresoras.keys()].join(', ')}`,
    );
  });

  // Bucle de reintentos: los trabajos que fallaron esperan su backoff y aquí
  // se vuelven a intentar sin que nadie tenga que pulsar nada.
  const intervalo = setInterval(() => {
    void despachador.drain(10).catch((error: unknown) => {
      console.error(
        `Fallo despachando la cola: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, 5_000);

  const apagar = (senal: string): void => {
    console.log(`${senal} recibido: cerrando el agente.`);
    clearInterval(intervalo);
    servidor.close(() => {
      // Se espera al despacho en curso: cortar el proceso a mitad de un envío
      // deja media comanda en el papel y el trabajo marcado como imprimiendo.
      void despachador.idle().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => apagar('SIGTERM'));
  process.on('SIGINT', () => apagar('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
