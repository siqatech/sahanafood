import {
  Catch,
  HttpException,
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

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
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
        ...exception.extra,
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

    res
      .status(problem.status)
      .setHeader('content-type', 'application/problem+json')
      .json(problem);
  }
}
