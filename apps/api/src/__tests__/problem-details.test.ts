import { describe, it, expect } from 'vitest';
import { ProblemDetailsFilter } from '../common/problem-details.filter.js';
import { DomainError } from '../common/errors.js';

/**
 * El filtro de errores es el último eslabón antes del cliente: si falla, la
 * petición no se responde. Esta suite fija los dos modos de fallo que ya
 * costaron caros.
 */

class ErrorConExtensiones extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/prueba';
  readonly title = 'Error de prueba';
  readonly code = 'PRUEBA';
}

/** Respuesta mínima que registra lo que el filtro intenta enviar. */
function respuestaFalsa() {
  const registro: { status?: unknown; body?: Record<string, unknown> } = {};
  const res = {
    status(s: unknown) {
      registro.status = s;
      return res;
    },
    setHeader() {
      return res;
    },
    json(b: Record<string, unknown>) {
      registro.body = b;
      return res;
    },
  };
  return { res, registro };
}

function hostFalso(res: unknown) {
  return {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ originalUrl: '/api/v1/prueba', traceId: 'trz-1' }),
    }),
  } as never;
}

describe('Filtro Problem Details', () => {
  const filtro = new ProblemDetailsFilter();

  it('una extensión NO puede pisar el status de Problem Details', () => {
    // Este es el bug que convirtió un 409 en un cuelgue de 30 segundos: el
    // error llevaba `{ status: 'preparing' }` como dato de negocio, el spread
    // lo colaba encima del código HTTP y `res.status('preparing')` dejaba la
    // petición sin responder.
    const { res, registro } = respuestaFalsa();
    filtro.catch(
      new ErrorConExtensiones('No se puede modificar.', {
        status: 'preparing',
        orderStatus: 'preparing',
      }),
      hostFalso(res),
    );

    expect(registro.status).toBe(409);
    expect(registro.body!.status).toBe(409);
    // El dato de negocio sigue llegando, con su nombre propio.
    expect(registro.body!.orderStatus).toBe('preparing');
  });

  it('ninguna extensión pisa los campos reservados de RFC 9457', () => {
    const { res, registro } = respuestaFalsa();
    filtro.catch(
      new ErrorConExtensiones('Detalle real.', {
        type: 'about:blank',
        title: 'Suplantado',
        detail: 'Suplantado',
        instance: '/otra',
        traceId: 'trz-falso',
        util: 42,
      }),
      hostFalso(res),
    );

    const body = registro.body!;
    expect(body.type).toBe('https://errors.sahana.food/prueba');
    expect(body.title).toBe('Error de prueba');
    expect(body.detail).toBe('Detalle real.');
    expect(body.instance).toBe('/api/v1/prueba');
    // El trace_id es el anclaje para encontrar el problema en los logs: si un
    // error pudiera falsearlo, el incidente reportado no se encontraría.
    expect(body.traceId).toBe('trz-1');
    expect(body.util).toBe(42);
  });

  it('un error interno no filtra detalles al cliente', () => {
    const { res, registro } = respuestaFalsa();
    filtro.catch(new Error('SELECT * FROM secretos falló'), hostFalso(res));
    expect(registro.status).toBe(500);
    expect(JSON.stringify(registro.body)).not.toContain('secretos');
  });
});
