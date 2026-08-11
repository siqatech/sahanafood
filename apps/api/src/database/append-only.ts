/**
 * Tablas append-only: se insertan, no se corrigen.
 *
 * No es una convención ni una promesa del código: el rol de aplicación
 * **no tiene** `UPDATE` ni `DELETE` sobre ellas, así que un `UPDATE` por
 * descuido no falla en revisión de código, falla en Postgres. Cada una lo
 * revoca en su propia migración, que es donde vive la verdad.
 *
 * Esta lista existe porque el arranque de un Postgres gestionado
 * (`bootstrap-roles.ts`) concede DML sobre TODAS las tablas de golpe —hace
 * falta para el caso «la base ya estaba migrada»— y ese GRANT masivo
 * volvería a conceder justo lo que las migraciones revocaron. Sin volver a
 * revocarlo aquí, re-ejecutar el arranque en un despliegue cualquiera
 * convertiría el histórico de auditoría en editable, en silencio.
 *
 * `append-only-contrato.test.ts` compara esta lista con los `REVOKE` reales de
 * `infra/migrations/`: si alguien añade una tabla append-only y no la añade
 * aquí, la prueba falla. Duplicar la lista sin esa comprobación sería peor que
 * no tenerla.
 */
export const TABLAS_APPEND_ONLY = [
  'audit_log',
  'bil_submissions',
  'cash_movements',
  'cat_catalog_versions',
  'inv_movements',
  'ord_order_events',
  'pay_webhook_events',
  'wa_consents',
] as const;
