import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PrintQueue } from '../queue/print-queue.js';
import type { PrintDispatcher } from '../queue/dispatcher.js';
import { buildKitchenTicket, buildPrecheck } from '../templates/tickets.js';

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

const lineaComandaSchema = z.object({
  quantity: z.number().int().positive(),
  productName: z.string().min(1),
  modifiersText: z.string().optional(),
  notes: z.string().optional(),
});

const comandaSchema = z.object({
  jobId: z.string().min(1).optional(),
  printer: z.string().min(1),
  orderNumber: z.number().int().positive(),
  brandName: z.string().min(1),
  stationName: z.string().min(1),
  channel: z.string().min(1),
  promisedAt: z.string().optional(),
  customerName: z.string().optional(),
  lines: z.array(lineaComandaSchema).min(1),
  notes: z.string().optional(),
});

const precuentaSchema = z.object({
  jobId: z.string().min(1).optional(),
  printer: z.string().min(1),
  orderNumber: z.number().int().positive(),
  brandName: z.string().min(1),
  locationName: z.string().min(1),
  lines: z
    .array(
      z.object({
        quantity: z.number().int().positive(),
        productName: z.string().min(1),
        // Ya formateado: el agente NO calcula dinero, solo lo imprime.
        lineTotal: z.string().min(1),
      }),
    )
    .min(1),
  subtotal: z.string().min(1),
  discount: z.string().optional(),
  deliveryFee: z.string().optional(),
  tip: z.string().optional(),
  total: z.string().min(1),
  taxLabel: z.string().min(1),
  tax: z.string().min(1),
});

export interface AgentServerOptions {
  queue: PrintQueue;
  dispatcher: PrintDispatcher;
  /** Token que la PWA obtuvo al emparejarse. */
  pairingToken: string;
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
          const dto = comandaSchema.parse(await leerCuerpo(req));
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
          const dto = precuentaSchema.parse(await leerCuerpo(req));
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

        return responder(res, 404, { error: 'Ruta desconocida.' });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return responder(res, 422, {
            error: 'Datos de impresión inválidos.',
            issues: error.issues.map((i) => i.message),
          });
        }
        return responder(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}
