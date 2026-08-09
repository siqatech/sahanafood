import type { PoliticaDeAceptacion } from '../../../lib/panel-api';

/**
 * Cuánto le queda a un pedido antes de que el sistema lo rechace solo
 * (RN-ORD-04).
 *
 * La política se resuelve **con el mismo criterio de especificidad que el
 * servidor** —cuanto más concreta, más manda—, y por el mismo motivo por el que
 * la tienda no calcula precios: dos reglas mentales distintas sobre el mismo
 * dato garantizan que un día la pantalla enseñe un reloj y el barrido haga otra
 * cosa. Si esto se separa del servidor, el operador ve «te quedan 4 minutos» en
 * un pedido que ya se rechazó.
 */

/** Manual, aviso a los 5 min y rechazo automático a los 10 (spec 05). */
export const POLITICA_POR_DEFECTO: PoliticaDeAceptacion = {
  brandId: null,
  channel: null,
  autoAccept: false,
  alertAfterMinutes: 5,
  autoRejectAfterMinutes: 10,
};

function especificidad(p: PoliticaDeAceptacion): number {
  return (p.brandId !== null ? 2 : 0) + (p.channel !== null ? 1 : 0);
}

export function politicaPara(
  politicas: PoliticaDeAceptacion[],
  brandId: string,
  channel: string,
): PoliticaDeAceptacion {
  const candidatas = politicas.filter(
    (p) =>
      (p.brandId === null || p.brandId === brandId) &&
      (p.channel === null || p.channel === channel),
  );
  if (candidatas.length === 0) return POLITICA_POR_DEFECTO;
  return candidatas.reduce((mejor, actual) =>
    especificidad(actual) > especificidad(mejor) ? actual : mejor,
  );
}

/** Instante (ISO) en que el barrido rechazará el pedido si nadie lo acepta. */
export function limiteDeRechazo(
  creadoEn: string,
  politica: PoliticaDeAceptacion,
): string {
  return new Date(
    Date.parse(creadoEn) + politica.autoRejectAfterMinutes * 60_000,
  ).toISOString();
}
