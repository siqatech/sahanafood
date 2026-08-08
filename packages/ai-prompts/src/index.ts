/**
 * Prompts versionados y suite de conversaciones doradas (T5.31).
 *
 * Paquete propio y no un archivo dentro de la API por una razón concreta: la
 * suite tiene que poder correr en CI contra CUALQUIER motor —el de hoy y el de
 * dentro de un año— y el criterio del backlog es que **un cambio de prompt que
 * degrada la suite no se mergea**. Con los prompts dentro del servicio, cambiar
 * uno y cambiar la prueba que lo cubre serían el mismo commit, que es
 * exactamente cómo una regresión se aprueba a sí misma.
 */
export {
  GOLDEN_DIALOGUES,
  compareGolden,
  formatFailures,
  type GoldenDialogue,
  type GoldenTurn,
  type GoldenResult,
  type GoldenFailure,
  type ExpectedResolution,
} from './golden.js';
export { SYSTEM_PROMPT_VERSION, buildSystemPrompt } from './system-prompt.js';
