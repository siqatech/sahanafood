/**
 * Errores de dominio → Problem Details (RFC 9457). Cada módulo define sus
 * errores extendiendo `DomainError`; el filtro global los serializa. Nunca se
 * filtran errores crudos de Drizzle/pg al cliente (convenciones docs/29).
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  /** URI estable que identifica el tipo de problema. */
  abstract readonly type: string;
  /** Título legible y estable (no varía con la instancia). */
  abstract readonly title: string;
  /**
   * Código corto y estable para que el cliente decida SIN leer el texto
   * (`ORDER_OUT_OF_COVERAGE`, `ORDER_BELOW_MINIMUM`...). El `title` y el
   * `detail` están para personas y pueden reescribirse o traducirse; el código
   * es contrato. Ver el catálogo en spec 05 §9.
   */
  readonly code?: string;

  constructor(
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = new.target.name;
  }
}

export class LimitExceededError extends DomainError {
  readonly status = 429;
  readonly type = 'https://errors.sahana.food/limit-exceeded';
  readonly title = 'Límite del plan excedido';
}

export class NotFoundError extends DomainError {
  readonly status = 404;
  readonly type = 'https://errors.sahana.food/not-found';
  readonly title = 'Recurso no encontrado';
}

export class ForbiddenError extends DomainError {
  readonly status = 403;
  readonly type = 'https://errors.sahana.food/forbidden';
  readonly title = 'Acción no permitida';
}

export class ValidationError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/validation';
  readonly title = 'Datos inválidos';
}
