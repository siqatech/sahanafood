/**
 * Token de inyección del proveedor de IA (ADR-0011 §3).
 *
 * Vive en su propio archivo para que el módulo pueda declarar el proveedor sin
 * que nadie importe la implementación concreta: cambiar de vendor es cambiar el
 * `useClass` del módulo y nada más.
 */
export const AI_PROVIDER = Symbol('AI_PROVIDER');
