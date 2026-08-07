import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Cifrado de credenciales de conector (RN-INT-04).
 *
 * Tres decisiones, cada una por un motivo concreto:
 *
 * 1. **Campo a campo, no el objeto entero.** Un blob único obliga a descifrarlo
 *    todo para leer un solo dato, y cualquier volcado accidental del objeto en
 *    claro expone todas las credenciales a la vez. Con cifrado por campo, el
 *    resto de la fila sigue siendo legible y depurable sin exponer secretos.
 *
 * 2. **Clave derivada por tenant** (HKDF sobre la clave maestra, con el
 *    tenant_id como `info`). Comprometer el ciphertext de un tenant no ayuda a
 *    descifrar el de otro, y el aislamiento no depende solo de la RLS.
 *
 * 3. **AES-256-GCM**, autenticado y con el tenant_id como AAD. Alterar el
 *    ciphertext o moverlo a la fila de otro tenant hace fallar la verificación
 *    en vez de devolver basura: un ataque de sustitución no se cuela.
 *
 * Nunca se registra el valor en claro en logs: quien maneja estos objetos debe
 * usar `redactCredentials` antes de imprimir nada.
 */

const ALG = 'aes-256-gcm';
const IV_BYTES = 12; // Tamaño canónico de nonce para GCM.
const KEY_BYTES = 32;

/** Sobre almacenado en `int_connections.credentials`. */
export interface EncryptedField {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export class CredentialCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCipherError';
  }
}

export function isEncryptedField(value: unknown): value is EncryptedField {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Partial<EncryptedField>;
  return (
    f.v === 1 &&
    typeof f.iv === 'string' &&
    typeof f.tag === 'string' &&
    typeof f.ct === 'string'
  );
}

/**
 * Deriva la clave del tenant. Se usa HKDF y no un hash directo porque la clave
 * maestra puede no tener 32 bytes de entropía uniforme y HKDF es justamente la
 * construcción diseñada para eso.
 */
function tenantKey(masterKey: string, tenantId: string): Buffer {
  if (masterKey.length < 32) {
    throw new CredentialCipherError(
      'La clave maestra de credenciales debe tener al menos 32 caracteres.',
    );
  }
  return Buffer.from(
    hkdfSync('sha256', masterKey, 'sahana.int.credentials', tenantId, KEY_BYTES),
  );
}

export class CredentialCipher {
  constructor(private readonly masterKey: string) {}

  encrypt(tenantId: string, plaintext: string): EncryptedField {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALG, tenantKey(this.masterKey, tenantId), iv);
    // El tenant_id va como dato autenticado: mover el sobre a otro tenant
    // invalida la etiqueta.
    cipher.setAAD(Buffer.from(tenantId, 'utf8'));
    const ct = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
  }

  decrypt(tenantId: string, field: EncryptedField): string {
    if (!isEncryptedField(field)) {
      throw new CredentialCipherError('Sobre de credencial malformado.');
    }
    // La derivación de clave va FUERA del try: su fallo es un error de
    // configuración («la clave maestra es corta») y debe decirlo con esas
    // palabras, no confundirse con un dato manipulado.
    const key = tenantKey(this.masterKey, tenantId);

    // El resto del descifrado sí va dentro, y no solo el `final()`: un IV de
    // longitud inválida hace fallar ya a `createDecipheriv`, y ese error
    // escaparía como excepción de crypto con detalles internos.
    try {
      const decipher = createDecipheriv(
        ALG,
        key,
        Buffer.from(field.iv, 'base64'),
      );
      decipher.setAAD(Buffer.from(tenantId, 'utf8'));
      decipher.setAuthTag(Buffer.from(field.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(field.ct, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // No se propaga el error original: su texto varía según el fallo y podría
      // servir de oráculo.
      throw new CredentialCipherError(
        'No se pudo descifrar la credencial: clave incorrecta o dato alterado.',
      );
    }
  }

  encryptAll(
    tenantId: string,
    values: Record<string, string>,
  ): Record<string, EncryptedField> {
    const out: Record<string, EncryptedField> = {};
    for (const [k, v] of Object.entries(values)) {
      out[k] = this.encrypt(tenantId, v);
    }
    return out;
  }

  decryptField(
    tenantId: string,
    credentials: Record<string, unknown>,
    name: string,
  ): string {
    const field = credentials[name];
    if (!isEncryptedField(field)) {
      throw new CredentialCipherError(
        `La conexión no tiene la credencial "${name}".`,
      );
    }
    return this.decrypt(tenantId, field);
  }
}

/**
 * Sustituye cualquier credencial por un marcador. Se usa antes de devolver una
 * conexión por API o de escribirla en un log: RN-INT-04 prohíbe que un secreto
 * salga de la BD, y el descuido típico es un `console.log(connection)`.
 */
export function redactCredentials<
  T extends Record<string, unknown> & { credentials?: unknown },
>(connection: T): Omit<T, 'credentials'> & { credentials: Record<string, '***'> } {
  const claves = Object.keys(
    (connection.credentials as Record<string, unknown>) ?? {},
  );
  const redacted: Record<string, '***'> = {};
  for (const k of claves) redacted[k] = '***';
  return { ...connection, credentials: redacted };
}

/** Comparación en tiempo constante para firmas HMAC. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual exige la misma longitud; comparar longitudes antes filtra
  // ese caso sin revelar nada que la longitud no revelase ya.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
