/**
 * Puerto hacia el OSE/PSE (ADR-0003).
 *
 * La interfaz es deliberadamente estrecha —«manda este comprobante», «pregunta
 * por este ticket»— porque es un ANTI-CORRUPTION LAYER: el día que se cambie
 * de proveedor (DP-02 sigue sin cerrarse), el cambio no puede tocar el
 * dominio. Cada OSE tiene su propio dialecto de XML, sus propios códigos de
 * error y su propia forma de decir «espera»; nada de eso debe filtrarse hacia
 * dentro.
 *
 * Los códigos de rechazo SÍ cruzan, pero normalizados: el servicio necesita
 * distinguir «esto no se va a arreglar solo» de «vuelve a intentarlo», y esa
 * distinción decide si el documento va a la cola de corrección o al reintento
 * automático. Confundirlas es reintentar 500 veces un RUC mal escrito, o
 * abandonar una venta por un corte de red de diez segundos.
 */

/** Lo que se manda al OSE. Ya calculado: aquí no se hacen cuentas. */
export interface SubmissionDocument {
  documentId: string;
  docType: 'boleta' | 'factura' | 'nota_credito';
  series: string;
  correlative: number;
  number: string;
  issuedAt: Date;

  issuer: { taxId: string; legalName: string };
  customer: {
    docType: string;
    docNumber?: string | undefined;
    name?: string | undefined;
  };

  /** Importes como cadena decimal: no pasan por coma flotante en ningún punto. */
  subtotal: string;
  taxableBase: string;
  tax: string;
  total: string;
  currency: string;

  lines: Array<{
    description: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
  }>;

  /** Documento que corrige, en notas de crédito. */
  references?: { number: string; docType: string } | undefined;
}

/**
 * Resultado de un envío.
 *
 * Tres desenlaces y no dos, porque «no aceptado» agrupa dos cosas que se
 * tratan al revés:
 *
 * · `rejected` — el OSE lo evaluó y dijo que no. Reintentarlo tal cual da el
 *   mismo resultado siempre: va a la cola de corrección (RN-BIL-02).
 * · `error` — no se pudo saber. Red caída, timeout, 500 del proveedor. Aquí
 *   reintentar es exactamente lo correcto.
 */
export type SubmissionOutcome =
  | { kind: 'accepted'; ticket: string; raw: Record<string, unknown> }
  | {
      kind: 'rejected';
      code: string;
      reason: string;
      raw: Record<string, unknown>;
    }
  | { kind: 'error'; message: string; retryable: true };

export interface BillingProvider {
  readonly name: string;
  submit(document: SubmissionDocument): Promise<SubmissionOutcome>;
  /**
   * Consulta un envío del que no se supo el desenlace.
   *
   * Es la pieza que evita el peor caso: mandar un comprobante, perder la
   * respuesta y reenviarlo — y que el OSE lo tenga ya registrado. Antes de
   * reintentar un `error`, se pregunta.
   */
  status(ticket: string): Promise<SubmissionOutcome>;
}
