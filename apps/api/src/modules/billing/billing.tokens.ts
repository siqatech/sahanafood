/**
 * Token de inyección del proveedor de facturación.
 *
 * Vive en su propio fichero para que el módulo y el servicio puedan importarlo
 * sin crear un ciclo: el módulo necesita al servicio y el servicio al token.
 */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');
