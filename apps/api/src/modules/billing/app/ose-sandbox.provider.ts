import { createHash } from 'node:crypto';
import type {
  BillingProvider,
  SubmissionDocument,
  SubmissionOutcome,
} from '../domain/billing-provider.js';

/**
 * Sandbox OSE simulado (ADR-0003, T4.26).
 *
 * DP-02 —qué OSE se contrata— sigue abierto, y CLAUDE.md prohíbe integrar
 * proveedores reales en el MVP. Este simulador no es un stub de conveniencia:
 * es lo que permite probar todo lo que de verdad duele en facturación sin
 * depender de un contrato que no existe.
 *
 * Reproduce los tres comportamientos que hacen difícil este módulo:
 *
 * 1. **Rechazos con código.** Un RUC mal formado, un total que no cuadra con
 *    las líneas, una serie con la letra equivocada. Son definitivos: se
 *    corrigen o no se emiten (RN-BIL-02).
 * 2. **Caídas.** Se puede tirar a voluntad para probar la cola y el reintento.
 *    El OSE cae de verdad, y bastante más de lo que uno espera.
 * 3. **Respuestas perdidas.** Acepta el documento pero la respuesta no llega.
 *    Es el caso que obliga a preguntar por el ticket antes de reenviar, y el
 *    que produce comprobantes duplicados en los sistemas que no lo contemplan.
 *
 * Es REPRODUCIBLE por semilla: los mismos datos dan el mismo resultado. Un
 * simulador aleatorio produce pruebas que fallan una vez de cada veinte y que
 * acaban desactivadas.
 */

export interface OseSandboxOptions {
  /** Fuerza que todo envío falle con error de red. */
  down?: boolean;
  /**
   * Acepta pero no contesta: el documento queda registrado en el OSE y quien
   * envió no lo sabe.
   */
  swallowResponses?: boolean;
  /** Latencia simulada, para medir el SLO de la spec (< 2 min). */
  latencyMs?: number;
}

/** Códigos de rechazo del catálogo de SUNAT que el MVP sabe producir. */
export const OSE_REJECTION_CODES = {
  RUC_INVALIDO: '2017',
  TOTAL_NO_CUADRA: '2321',
  SERIE_INVALIDA: '2027',
  DUPLICADO: '1033',
} as const;

export class OseSandboxProvider implements BillingProvider {
  readonly name = 'ose-sandbox';

  /** Lo aceptado, por ticket. Es la "memoria" del OSE. */
  private readonly aceptados = new Map<string, SubmissionDocument>();
  /** Números ya registrados: reenviar el mismo número da 1033, como el real. */
  private readonly numerosVistos = new Map<string, string>();

  constructor(private options: OseSandboxOptions = {}) {}

  configure(options: OseSandboxOptions): void {
    this.options = { ...this.options, ...options };
  }

  /** Ticket determinista: mismo documento, mismo ticket. */
  private ticketDe(doc: SubmissionDocument): string {
    return createHash('sha256')
      .update(`${doc.series}|${doc.correlative}|${doc.issuer.taxId}`)
      .digest('hex')
      .slice(0, 24);
  }

  async submit(doc: SubmissionDocument): Promise<SubmissionOutcome> {
    if (this.options.latencyMs) {
      await new Promise((r) => setTimeout(r, this.options.latencyMs));
    }

    if (this.options.down) {
      return {
        kind: 'error',
        message: 'El OSE no responde (simulado).',
        retryable: true,
      };
    }

    const rechazo = this.validar(doc);
    if (rechazo) return rechazo;

    const ticket = this.ticketDe(doc);
    const clave = `${doc.issuer.taxId}|${doc.number}`;

    // Reenvío del MISMO número ya aceptado. El OSE real lo rechaza con 1033, y
    // es correcto: el comprobante ya está declarado. Lo que NO puede hacer el
    // emisor es tratarlo como fallo — por eso existe `status()`.
    const previo = this.numerosVistos.get(clave);
    if (previo && previo !== doc.documentId) {
      return {
        kind: 'rejected',
        code: OSE_REJECTION_CODES.DUPLICADO,
        reason: `El comprobante ${doc.number} ya fue registrado.`,
        raw: { ticket: previo },
      };
    }

    this.aceptados.set(ticket, doc);
    this.numerosVistos.set(clave, doc.documentId);

    if (this.options.swallowResponses) {
      // Aceptado por el OSE, pero quien envió no se entera. El documento
      // existe allí y aquí sigue pendiente: reenviarlo a ciegas lo duplicaría.
      return {
        kind: 'error',
        message: 'Sin respuesta del OSE (simulado): estado desconocido.',
        retryable: true,
      };
    }

    return {
      kind: 'accepted',
      ticket,
      raw: { ticket, estado: 'ACEPTADO', numero: doc.number },
    };
  }

  async status(ticket: string): Promise<SubmissionOutcome> {
    if (this.options.down) {
      return {
        kind: 'error',
        message: 'El OSE no responde (simulado).',
        retryable: true,
      };
    }
    const doc = this.aceptados.get(ticket);
    if (!doc) {
      return {
        kind: 'error',
        message: `Ticket ${ticket} desconocido.`,
        retryable: true,
      };
    }
    return {
      kind: 'accepted',
      ticket,
      raw: { ticket, estado: 'ACEPTADO', numero: doc.number },
    };
  }

  /** Busca el ticket de un número ya enviado, para reconciliar tras un corte. */
  ticketOf(taxId: string, number: string): string | undefined {
    for (const [ticket, doc] of this.aceptados) {
      if (doc.issuer.taxId === taxId && doc.number === number) return ticket;
    }
    return undefined;
  }

  /**
   * Validaciones equivalentes a las que hace SUNAT.
   *
   * Están aquí y no solo en el dominio a propósito: el sandbox tiene que poder
   * rechazar cosas que nuestro código deja pasar, o las pruebas de la cola de
   * corrección no probarían nada.
   */
  private validar(doc: SubmissionDocument): SubmissionOutcome | null {
    if (doc.docType === 'factura') {
      if (!/^\d{11}$/.test(doc.customer.docNumber ?? '')) {
        return {
          kind: 'rejected',
          code: OSE_REJECTION_CODES.RUC_INVALIDO,
          reason: 'El RUC del receptor no tiene 11 dígitos.',
          raw: {},
        };
      }
    }

    const esperado = doc.docType === 'factura' ? 'F' : 'B';
    if (doc.docType !== 'nota_credito' && !doc.series.startsWith(esperado)) {
      return {
        kind: 'rejected',
        code: OSE_REJECTION_CODES.SERIE_INVALIDA,
        reason: `La serie ${doc.series} no corresponde a una ${doc.docType}.`,
        raw: {},
      };
    }

    // El total tiene que cuadrar con las líneas. Se compara en céntimos
    // enteros: comparar decimales en coma flotante fallaría por 0.0001 y
    // rechazaría comprobantes correctos, que es peor que no comprobar.
    const suma = doc.lines.reduce(
      (acc, l) => acc + Math.round(Number(l.lineTotal) * 10_000),
      0,
    );
    const total = Math.round(Number(doc.total) * 10_000);
    if (doc.lines.length > 0 && suma !== total) {
      return {
        kind: 'rejected',
        code: OSE_REJECTION_CODES.TOTAL_NO_CUADRA,
        reason: `El total (${doc.total}) no coincide con la suma de las líneas.`,
        raw: { sumaLineas: suma / 10_000 },
      };
    }

    return null;
  }
}
