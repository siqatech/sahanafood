import { z } from 'zod';

/**
 * Contratos de API compartidos (borde de validación con zod). Se irán poblando
 * por módulo en Fase 3+. Aquí, los tipos base transversales.
 *
 * Regla de dinero (ADR-0006): en DTOs, el dinero viaja como céntimos ENTEROS +
 * moneda, nunca como decimal de punto flotante.
 */

/** Representación de dinero en el borde: entero de céntimos + moneda ISO-4217. */
export const moneyDtoSchema = z.object({
  minorUnits: z.number().int(),
  currency: z.enum(['PEN', 'USD']),
  scale: z.number().int().min(0).max(4).default(4),
});
export type MoneyDto = z.infer<typeof moneyDtoSchema>;

/** Envelope de error Problem Details (RFC 9457). */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string().optional(),
  traceId: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
