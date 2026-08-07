import type { TenantContext } from '../../../database/rls.js';

/**
 * Resolución de la política de aceptación (RN-ORD-04).
 *
 * Vive en su propio archivo, como función libre que recibe el `TenantContext`,
 * por dos motivos concretos:
 *
 * 1. `OrderingService.submit` la necesita DENTRO de su transacción para que un
 *    pedido con aceptación automática nazca ya aceptado, sin una ventana en la
 *    que exista `received` y aún no lo esté.
 * 2. Si en cambio viviera en `AcceptanceService`, que a su vez usa
 *    `OrderingService` para transicionar, habría un ciclo de dependencias que
 *    dependency-cruiser rechaza — y con razón.
 */

export interface AcceptancePolicy {
  autoAccept: boolean;
  alertAfterMinutes: number;
  autoRejectAfterMinutes: number;
}

/** Manual, aviso a los 5 min y rechazo automático a los 10 (spec 05 RN-ORD-04). */
export const DEFAULT_ACCEPTANCE_POLICY: AcceptancePolicy = {
  autoAccept: false,
  alertAfterMinutes: 5,
  autoRejectAfterMinutes: 10,
};

interface PolicyRow {
  brand_id: string | null;
  channel: string | null;
  auto_accept: boolean;
  alert_after_minutes: number;
  auto_reject_after_minutes: number;
}

/**
 * Especificidad: cuanto más concreta, más manda. Mismo criterio que la
 * resolución de precios del catálogo — tener dos reglas mentales distintas en
 * el mismo producto garantiza sorpresas.
 */
function specificity(row: PolicyRow): number {
  return (row.brand_id !== null ? 2 : 0) + (row.channel !== null ? 1 : 0);
}

export async function resolveAcceptancePolicy(
  ctx: TenantContext,
  brandId: string,
  channel: string,
): Promise<AcceptancePolicy> {
  const { rows } = await ctx.client.query<PolicyRow>(
    `SELECT brand_id, channel, auto_accept, alert_after_minutes,
            auto_reject_after_minutes
       FROM ord_acceptance_policies
      WHERE (brand_id IS NULL OR brand_id = $1)
        AND (channel IS NULL OR channel = $2)`,
    [brandId, channel],
  );

  if (rows.length === 0) return DEFAULT_ACCEPTANCE_POLICY;

  const ganadora = rows.reduce((mejor, actual) =>
    specificity(actual) > specificity(mejor) ? actual : mejor,
  );
  return {
    autoAccept: ganadora.auto_accept,
    alertAfterMinutes: ganadora.alert_after_minutes,
    autoRejectAfterMinutes: ganadora.auto_reject_after_minutes,
  };
}
