import { PrintQueue } from './queue/print-queue.js';
import { PrintDispatcher } from './queue/dispatcher.js';
import { createAgentServer } from './api/server.js';
import { loadConfig, transportMap } from './config.js';
import { runDoctor, formatDoctor, doctorOk } from './doctor.js';
import { VERSION } from './version.js';

/**
 * Punto de entrada del agente de impresión (ADR-0008).
 *
 * Se instala en una máquina del local y corre como servicio. Todo lo que
 * necesita saber viene de variables de entorno (ver `config.ts`).
 *
 *   node dist/main.js           → arranca el servicio
 *   node dist/main.js doctor    → diagnostica y sale (lo usa el instalador)
 */

async function diagnosticar(): Promise<never> {
  const resultados = await runDoctor();
  console.log(formatDoctor(resultados));
  // Código de salida distinto de 0 para que el instalador pueda abortar sin
  // tener que interpretar el texto.
  process.exit(doctorOk(resultados) ? 0 : 1);
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const cola = new PrintQueue({ filePath: config.queueFile });
  const recuperados = await cola.load();
  if (recuperados > 0) {
    // Es la línea que explica por qué salen tickets solos al arrancar tras un
    // corte de luz. Sin ella, parecería un fantasma.
    console.log(
      `Cola recuperada del disco: ${recuperados} trabajos, ${cola.pendingCount()} pendientes de imprimir.`,
    );
  }

  const despachador = new PrintDispatcher(cola, transportMap(config.printers));

  const servidor = createAgentServer({
    queue: cola,
    dispatcher: despachador,
    pairingToken: config.token,
    printers: config.printers,
    ticketWidth: config.ticketWidth,
    agentVersion: VERSION,
  });

  // SOLO localhost: un agente en 0.0.0.0 deja que cualquier teléfono del wifi
  // del local imprima en la cocina.
  servidor.listen(config.port, '127.0.0.1', () => {
    console.log(
      `Agente de impresión v${VERSION} escuchando en http://127.0.0.1:${config.port} — impresoras: ${config.printers
        .map((p) => p.name)
        .join(', ')}`,
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

const comando = process.argv[2];
const arranque = comando === 'doctor' ? diagnosticar() : bootstrap();

void arranque.catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
