import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ModifierError, PricingError, MoneyError } from '@sahana/domain';
import { DomainError } from './errors.js';

/**
 * Filtro global que serializa TODA excepción como Problem Details
 * (RFC 9457, `application/problem+json`). Incluye el trace_id para correlación
 * con logs/OTel. Los errores no controlados se degradan a 500 sin filtrar
 * detalles internos al cliente.
 */
interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  traceId?: string | undefined;
  [k: string]: unknown;
}

/**
 * Campos que define RFC 9457 y que una extensión no puede redefinir. La lista
 * incluye `traceId` porque es nuestro anclaje para correlacionar con los logs:
 * si un error lo sobrescribiera, el problema reportado dejaría de encontrarse.
 */
const RESERVED_FIELDS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'traceId',
]);

function omitReservedFields(
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const salida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (!RESERVED_FIELDS.has(k)) salida[k] = v;
  }
  return salida;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private static readonly logger = new Logger('ProblemDetails');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { traceId?: string }>();
    const traceId = req.traceId;

    let problem: ProblemDetails;

    if (exception instanceof DomainError) {
      problem = {
        type: exception.type,
        title: exception.title,
        status: exception.status,
        detail: exception.detail,
        instance: req.originalUrl,
        traceId,
        ...(exception.code !== undefined ? { code: exception.code } : {}),
        // Las extensiones van DESPUÉS pero SIN poder pisar los campos base.
        // Un error que traiga `{ status: 'preparing' }` como dato de negocio
        // convertiría `problem.status` en una cadena, y `res.status(...)` con
        // una cadena deja la petición sin responder hasta que el cliente se
        // rinde: un 409 se transforma en un cuelgue de 30 s.
        ...omitReservedFields(exception.extra),
      };
    } else if (
      exception instanceof ModifierError ||
      exception instanceof PricingError ||
      exception instanceof MoneyError
    ) {
      // El dominio compartido no conoce HTTP —y no debe—, así que sus errores
      // se traducen aquí. Son fallos de ENTRADA del cliente (un modificador
      // obligatorio sin elegir, una cantidad inválida): degradarlos a 500
      // dejaría al usuario sin saber qué corregir.
      problem = {
        type: 'https://errors.sahana.food/validation',
        title: 'Datos inválidos',
        status: 422,
        detail: exception.message,
        instance: req.originalUrl,
        traceId,
        ...('code' in exception ? { code: exception.code } : {}),
        ...('groupId' in exception && exception.groupId !== undefined
          ? { groupId: exception.groupId }
          : {}),
      };
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const detail =
        typeof response === 'string'
          ? response
          : ((response as { message?: unknown }).message?.toString() ??
            exception.message);
      problem = {
        type: 'about:blank',
        title: exception.name,
        status,
        detail,
        instance: req.originalUrl,
        traceId,
      };
    } else {
      // Nunca exponer el error interno al cliente.
      problem = {
        type: 'about:blank',
        title: 'Error interno',
        status: 500,
        detail: 'Ocurrió un error inesperado.',
        instance: req.originalUrl,
        traceId,
      };
    }

    // Defensa en profundidad: pase lo que pase, esta petición se responde. Un
    // código no numérico haría que Express no enviara nada y el cliente
    // esperaría hasta su propio timeout; es mejor un 500 honesto que un
    // cuelgue, que además consume una conexión mientras dura.
    const status =
      Number.isInteger(problem.status) &&
      problem.status >= 100 &&
      problem.status <= 599
        ? problem.status
        : 500;

    // Un 5xx SE REGISTRA con su traza y su causa real.
    //
    // Sin esto, el cliente se lleva un `traceId` y en el servidor no queda
    // nada que correlacionar: soporte recibe «me salió error, traza
    // 01KZF…» y no hay dónde buscarla. Los 4xx no se registran —son
    // peticiones mal formadas, ocurren todo el rato y llenarían el log de
    // ruido—, pero un 500 es siempre algo que no previmos.
    if (status >= 500) {
      const causa =
        exception instanceof Error ? exception : new Error(String(exception));
      ProblemDetailsFilter.logger.error(
        `${req.method} ${req.originalUrl} → ${status} [${traceId ?? 'sin traza'}]: ${causa.message}`,
        causa.stack,
      );
    }

    res
      .status(status)
      .setHeader('content-type', 'application/problem+json')
      .json({ ...problem, status });
  }
}
