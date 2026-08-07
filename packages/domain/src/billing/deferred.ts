import { BillingError } from './document-type.js';

/**
 * Emisión diferida: cuándo un comprobante encolado se está quedando tarde
 * (spec 10, RN-BIL-03).
 *
 * Una venta sin internet se cobra igual y su comprobante espera en cola. Lo
 * que no puede esperar indefinidamente es el ENVÍO: SUNAT da un plazo desde la
 * fecha de emisión, y pasarse convierte un problema de conectividad en una
 * infracción tributaria del cliente, no nuestra.
 *
 * Por eso la cuenta se hace contra la **fecha de emisión real** —cuando se
 * cobró— y no contra el momento en que se logró enviar. Contar desde el envío
 * haría que un documento con tres días de retraso pareciera recién nacido, que
 * es exactamente el error que oculta el problema hasta que ya no tiene arreglo.
 *
 * Los límites son configurables porque la norma cambia y varía por tipo de
 * comprobante; el valor por defecto es conservador a propósito.
 */

export type DeferredStatus = 'ok' | 'warning' | 'expired';

export interface DeferralPolicy {
  /** Horas desde la emisión antes de que el envío incumpla el plazo. */
  limitHours: number;
  /**
   * Con cuántas horas de antelación avisar. El aviso tiene que llegar con
   * tiempo de hacer algo —levantar el internet del local, llamar a soporte—:
   * avisar al vencer no es avisar, es informar de un incumplimiento.
   */
  warnBeforeHours: number;
}

/**
 * 72 horas es el plazo habitual para boletas en Perú, y avisar a las 24 deja
 * dos días hábiles para reaccionar. Ambos se sobreescriben por tenant cuando
 * DP-02 (proveedor OSE) confirme los plazos de su contrato.
 */
export const DEFAULT_DEFERRAL_POLICY: DeferralPolicy = {
  limitHours: 72,
  warnBeforeHours: 24,
};

export interface DeferredCheck {
  status: DeferredStatus;
  /** Horas transcurridas desde la emisión real. */
  ageHours: number;
  /** Horas que quedan antes de incumplir. Negativo si ya se pasó. */
  hoursRemaining: number;
}

export function checkDeferredIssuance(
  emittedAt: Date,
  now: Date,
  policy: DeferralPolicy = DEFAULT_DEFERRAL_POLICY,
): DeferredCheck {
  if (
    !Number.isFinite(emittedAt.getTime()) ||
    !Number.isFinite(now.getTime())
  ) {
    throw new BillingError(
      'Fecha inválida al evaluar la emisión diferida.',
      'BILLING_INVALID_DATE',
    );
  }
  if (policy.limitHours <= 0 || policy.warnBeforeHours < 0) {
    throw new BillingError(
      'La política de emisión diferida necesita un límite positivo.',
      'BILLING_INVALID_POLICY',
    );
  }
  if (policy.warnBeforeHours >= policy.limitHours) {
    // Avisar antes de empezar no avisa de nada: sería una alerta permanente,
    // y una alerta que siempre está encendida es una alerta que nadie mira.
    throw new BillingError(
      'El aviso debe llegar antes del límite, no desde el primer minuto.',
      'BILLING_INVALID_POLICY',
    );
  }

  const horas = (now.getTime() - emittedAt.getTime()) / 3_600_000;
  // Un reloj desajustado en la caja puede dar una emisión "en el futuro". Se
  // trata como recién emitida en vez de como un error: la venta ya ocurrió y
  // no vamos a bloquear su comprobante por la hora de una tablet.
  const edad = Math.max(0, horas);
  const restantes = policy.limitHours - edad;

  const status: DeferredStatus =
    restantes <= 0
      ? 'expired'
      : restantes <= policy.warnBeforeHours
        ? 'warning'
        : 'ok';

  return { status, ageHours: edad, hoursRemaining: restantes };
}

/**
 * Orden de envío de la cola diferida.
 *
 * Lo más antiguo primero, SIEMPRE. La tentación es despachar antes lo que
 * acaba de entrar —es lo que el operador está mirando— y es justo al revés:
 * el documento viejo es el único que puede vencer, y el nuevo tiene 72 horas
 * por delante.
 */
export function deferredQueueOrder<T extends { emittedAt: Date }>(
  documentos: readonly T[],
): T[] {
  return [...documentos].sort(
    (a, b) => a.emittedAt.getTime() - b.emittedAt.getTime(),
  );
}
