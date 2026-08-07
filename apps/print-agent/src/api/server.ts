import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { PrintQueue } from '../queue/print-queue.js';
import type { PrintDispatcher } from '../queue/dispatcher.js';
import { buildKitchenTicket, buildPrecheck } from '../templates/tickets.js';
import {
  parseComanda,
  parsePrecuenta,
  parsePrueba,
  DatosInvalidosError,
} from './validation.js';
import { buildTestPage } from '../templates/test-page.js';
import { scanForPrinters, localPrefixes } from '../discovery/scan.js';
import type { PrinterSpec } from '../config.js';

/**
 * API local del agente (ADR-0008).
 *
 * Dos decisiones de seguridad que parecen exageradas para «un servicio en
 * localhost» y no lo son:
 *
 * 1. **Escucha SOLO en 127.0.0.1.** Un agente escuchando en 0.0.0.0 dentro del
 *    wifi del local deja que cualquier teléfono conectado imprima lo que
 *    quiera en la cocina. El wifi de un restaurante no es una red de confianza.
 * 2. **Token de emparejamiento con comparación en tiempo constante.** Otras
 *    páginas abiertas en el mismo navegador pueden hacer peticiones a
 *    localhost; el token es lo que distingue a nuestra PWA de una pestaña
 *    cualquiera.
 */

export interface AgentServerOptions {
  queue: PrintQueue;
  dispatcher: PrintDispatcher;
  /** Token que la PWA obtuvo al emparejarse. */
  pairingToken: string;
  /** Impresoras configuradas, para la página de prueba y el asistente. */
  printers?: PrinterSpec[];
  agentVersion?: string;
  ticketWidth?: number;
  /** Reloj inyectable para poder probar el sello de hora. */
  now?: () => Date;
  /** Dónde van los fallos del despacho en segundo plano. */
  onError?: (error: unknown) => void;
}

function tokenValido(recibido: string | undefined, esperado: string): boolean {
  if (!recibido) return false;
  const a = Buffer.from(recibido, 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  // Longitudes distintas: comparar aquí no revela nada que la longitud no
  // revelase ya, y timingSafeEqual exige que coincidan.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  const trozos: Buffer[] = [];
  for await (const trozo of req) trozos.push(trozo as Buffer);
  if (trozos.length === 0) return {};
  return JSON.parse(Buffer.concat(trozos).toString('utf8'));
}

function responder(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function createAgentServer(options: AgentServerOptions): Server {
  const ahora = options.now ?? (() => new Date());
  const avisar =
    options.onError ??
    ((error: unknown): void => {
      console.error(
        `Fallo despachando la cola: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  // El despacho se lanza sin esperarlo, así que su error no tiene a nadie
  // detrás: sin este `catch` un disco lleno tumbaría el agente entero por
  // rechazo no gestionado, y el local se quedaría sin imprimir nada.
  const despacharEnSegundoPlano = (): void => {
    void options.dispatcher.drain(5).catch(avisar);
  };
  const selloDeHora = (): string =>
    ahora().toLocaleString('es-PE', { hour12: false });

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');

        // La salud es pública: la PWA la consulta para saber si el agente está
        // vivo ANTES de tener token, y no revela nada.
        if (req.method === 'GET' && url.pathname === '/health') {
          return responder(res, 200, {
            status: 'ok',
            pendingJobs: options.queue.pendingCount(),
            failedJobs: options.queue.failed().length,
            printers: await options.dispatcher.health(),
          });
        }

        if (
          !tokenValido(
            req.headers['x-agent-token'] as string,
            options.pairingToken,
          )
        ) {
          return responder(res, 401, {
            error: 'Token de agente inválido. Vuelve a emparejar la caja.',
          });
        }

        if (req.method === 'POST' && url.pathname === '/print/kitchen') {
          const dto = parseComanda(await leerCuerpo(req));
          const jobId = dto.jobId ?? randomUUID();
          const job = await options.queue.enqueue({
            id: jobId,
            printer: dto.printer,
            kind: 'kitchen_ticket',
            reference: `#${dto.orderNumber}`,
            payload: buildKitchenTicket(
              { ...dto, printedAt: selloDeHora() },
              { width: options.ticketWidth },
            ),
          });
          // Se despacha en el acto, pero la respuesta NO espera a la
          // impresora: si tarda, la PWA no puede quedarse bloqueada con el
          // cliente delante.
          despacharEnSegundoPlano();
          return responder(res, 202, { jobId: job.id, status: job.status });
        }

        if (req.method === 'POST' && url.pathname === '/print/precheck') {
          const dto = parsePrecuenta(await leerCuerpo(req));
          const jobId = dto.jobId ?? randomUUID();
          const job = await options.queue.enqueue({
            id: jobId,
            printer: dto.printer,
            kind: 'precheck',
            reference: `#${dto.orderNumber}`,
            payload: buildPrecheck(
              { ...dto, printedAt: selloDeHora() },
              { width: options.ticketWidth },
            ),
          });
          despacharEnSegundoPlano();
          return responder(res, 202, { jobId: job.id, status: job.status });
        }

        if (req.method === 'POST' && url.pathname.startsWith('/jobs/')) {
          const partes = url.pathname.split('/');
          if (partes[3] === 'reprint') {
            const original = options.queue.get(partes[2]!);
            // 404 y no 500: reimprimir un trabajo ya purgado es un error del
            // operador, no una avería del agente, y el panel debe poder
            // distinguirlos para decir algo útil.
            if (!original) {
              return responder(res, 404, {
                error: `No existe el trabajo de impresión ${partes[2]}.`,
              });
            }
            const copia = await options.queue.reprint(partes[2]!, randomUUID());
            despacharEnSegundoPlano();
            return responder(res, 202, { jobId: copia.id });
          }
        }

        if (req.method === 'GET' && url.pathname === '/jobs') {
          return responder(res, 200, {
            jobs: options.queue.all().map((j) => ({
              id: j.id,
              printer: j.printer,
              kind: j.kind,
              reference: j.reference,
              status: j.status,
              attempts: j.attempts,
              lastError: j.lastError ?? null,
            })),
          });
        }

        // Página de prueba: es el entregable real de la instalación. «El
        // servicio arrancó» no prueba nada — el agente arranca igual con la
        // impresora apagada. Lo que cierra la instalación es un papel.
        if (req.method === 'POST' && url.pathname === '/printers/test') {
          const dto = parsePrueba(await leerCuerpo(req));
          const impresora = (options.printers ?? []).find(
            (p) => p.name === dto.printer,
          );
          if (!impresora) {
            return responder(res, 404, {
              error: `No hay ninguna impresora configurada con el nombre "${dto.printer}".`,
              configuradas: (options.printers ?? []).map((p) => p.name),
            });
          }
          const job = await options.queue.enqueue({
            id: dto.jobId ?? randomUUID(),
            printer: impresora.name,
            kind: 'test_page',
            reference: 'prueba',
            payload: buildTestPage(
              {
                printerName: impresora.name,
                target: impresora.target,
                agentVersion: options.agentVersion ?? 'desconocida',
                printedAt: selloDeHora(),
              },
              { width: options.ticketWidth },
            ),
          });
          despacharEnSegundoPlano();
          return responder(res, 202, { jobId: job.id });
        }

        // Asistente de instalación: la IP de una térmica no está escrita en
        // ninguna parte, y pedírsela a quien monta el local es pedir demasiado.
        if (req.method === 'GET' && url.pathname === '/printers/discover') {
          const prefijo = url.searchParams.get('prefix');
          const prefijos = prefijo ? [prefijo] : localPrefixes();
          const halladas = (
            await Promise.all(
              prefijos.map((p) => scanForPrinters({ prefix: p })),
            )
          ).flat();
          return responder(res, 200, {
            scannedPrefixes: prefijos,
            printers: halladas,
          });
        }

        return responder(res, 404, { error: 'Ruta desconocida.' });
      } catch (error) {
        if (error instanceof DatosInvalidosError) {
          return responder(res, 422, {
            error: 'Datos de impresión inválidos.',
            issues: error.issues,
          });
        }
        return responder(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}
