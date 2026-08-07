/**
 * Qué comprobante corresponde emitir (spec 10, RN-BIL-01).
 *
 * Vive en el dominio porque el POS tiene que llegar a la MISMA conclusión sin
 * red: si el cajero teclea un RUC y la caja dice «boleta» mientras el servidor
 * dice «factura», el papel que se lleva el cliente no coincide con lo que se
 * declara a SUNAT. Eso no es un bug de interfaz, es un problema tributario.
 *
 * La regla peruana, reducida a lo que el MVP necesita:
 *
 * · **Factura** cuando el receptor se identifica con RUC (11 dígitos). Es lo
 *   que permite al cliente usar el gasto como crédito fiscal, y es la razón
 *   por la que la pide.
 * · **Boleta** en cualquier otro caso: con DNI, con carné de extranjería, o
 *   sin identificar. La venta al público no necesita documento del cliente.
 * · **Nota de crédito** para anular o corregir una venta ya facturada. Nunca
 *   se borra un comprobante emitido — se emite otro que lo revierte.
 *
 * Lo que aquí NO se decide: si la venta lleva comprobante. La lleva siempre.
 */

export type DocumentType = 'boleta' | 'factura' | 'nota_credito';

/** Tipos de documento de identidad del receptor, según el catálogo de SUNAT. */
export type CustomerDocType = 'DNI' | 'RUC' | 'CE' | 'PASAPORTE' | 'NONE';

export class BillingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

export interface CustomerIdentity {
  docType: CustomerDocType;
  /** Sin espacios ni guiones. */
  docNumber?: string | undefined;
  legalName?: string | undefined;
}

/**
 * Longitudes exactas del catálogo de SUNAT. Se validan aquí y no en el
 * controlador porque el POS offline también tiene que rechazarlas: un RUC de
 * 10 dígitos aceptado sin red es un comprobante que el OSE devolverá rechazado
 * horas después, con el cliente ya fuera del local.
 */
const LONGITUDES: Record<CustomerDocType, number | null> = {
  DNI: 8,
  RUC: 11,
  CE: 12,
  PASAPORTE: null, // longitud variable
  NONE: null,
};

export function assertValidIdentity(identidad: CustomerIdentity): void {
  const { docType, docNumber } = identidad;

  if (docType === 'NONE') {
    if (docNumber) {
      throw new BillingError(
        'Hay número de documento pero no se indicó de qué tipo es.',
        'BILLING_DOC_TYPE_MISSING',
      );
    }
    return;
  }

  if (!docNumber?.trim()) {
    throw new BillingError(
      `Falta el número de documento para el tipo ${docType}.`,
      'BILLING_DOC_NUMBER_MISSING',
    );
  }
  if (!/^[A-Za-z0-9]+$/.test(docNumber)) {
    throw new BillingError(
      `El número de documento solo admite letras y dígitos: "${docNumber}".`,
      'BILLING_DOC_NUMBER_INVALID',
    );
  }

  const esperada = LONGITUDES[docType];
  if (esperada !== null && docNumber.length !== esperada) {
    throw new BillingError(
      `Un ${docType} tiene ${esperada} caracteres; llegaron ${docNumber.length}.`,
      'BILLING_DOC_NUMBER_INVALID',
    );
  }
  if (docType === 'DNI' || docType === 'RUC') {
    if (!/^\d+$/.test(docNumber)) {
      throw new BillingError(
        `Un ${docType} es solo dígitos: "${docNumber}".`,
        'BILLING_DOC_NUMBER_INVALID',
      );
    }
  }

  // La factura sale a nombre de alguien; sin razón social, SUNAT la rechaza y
  // el cliente se queda sin su crédito fiscal.
  if (docType === 'RUC' && !identidad.legalName?.trim()) {
    throw new BillingError(
      'Una factura necesita la razón social del receptor.',
      'BILLING_LEGAL_NAME_MISSING',
    );
  }
}

/**
 * Qué comprobante emitir para esta venta.
 *
 * No lanza cuando falta identidad: la venta al público no necesita documento
 * del cliente, y negarse a facturar por eso pararía la caja.
 */
export function resolveDocumentType(
  identidad: CustomerIdentity,
): 'boleta' | 'factura' {
  return identidad.docType === 'RUC' ? 'factura' : 'boleta';
}

/**
 * Formato del número: `SERIE-CORRELATIVO` con el correlativo a 8 dígitos.
 *
 * Es el formato que SUNAT espera y el que lee el cliente. Se construye aquí,
 * en un solo sitio, porque un correlativo sin rellenar («B001-42» en vez de
 * «B001-00000042») pasa la validación local y lo rechaza el OSE.
 */
export function formatDocumentNumber(
  series: string,
  correlative: number,
): string {
  if (!Number.isInteger(correlative) || correlative <= 0) {
    throw new BillingError(
      `Correlativo inválido: ${correlative}.`,
      'BILLING_CORRELATIVE_INVALID',
    );
  }
  return `${series}-${String(correlative).padStart(8, '0')}`;
}

/**
 * Prefijo válido de serie según el tipo (catálogo de SUNAT).
 *
 * `F` para facturas, `B` para boletas, y las notas de crédito heredan la letra
 * del documento que corrigen. Una serie con el prefijo equivocado es un
 * rechazo garantizado del OSE, y se descubre con la venta ya cobrada.
 */
export function assertValidSeries(series: string, type: DocumentType): void {
  if (!/^[FB][A-Z0-9]{3}$/.test(series)) {
    throw new BillingError(
      `Serie inválida: "${series}". Debe ser una letra F o B seguida de 3 caracteres (p. ej. F001).`,
      'BILLING_SERIES_INVALID',
    );
  }
  const esperado = type === 'factura' ? 'F' : type === 'boleta' ? 'B' : null;
  if (esperado && !series.startsWith(esperado)) {
    throw new BillingError(
      `Una ${type} necesita una serie que empiece por "${esperado}"; llegó "${series}".`,
      'BILLING_SERIES_INVALID',
    );
  }
}
