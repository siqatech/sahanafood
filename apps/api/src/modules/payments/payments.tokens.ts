/**
 * Token de inyección de las pasarelas de pago.
 *
 * Es una LISTA, no un único proveedor como en facturación: la spec 10 pide
 * «2 pasarelas mínimo vía adaptador», y un tenant puede cobrar con una mientras
 * otro cobra con otra. El servicio las indexa por nombre al arrancar.
 *
 * Vive en su propio fichero para que el módulo y el servicio puedan importarlo
 * sin crear un ciclo.
 */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
