import { describe, it, expect } from 'vitest';
import {
  CredentialCipher,
  CredentialCipherError,
  isEncryptedField,
  redactCredentials,
  safeEqual,
} from './credential-cipher.js';

const CLAVE = 'clave-maestra-de-pruebas-con-mas-de-32-caracteres';
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

describe('Cifrado de credenciales de conector (RN-INT-04)', () => {
  const cipher = new CredentialCipher(CLAVE);

  it('ida y vuelta devuelve el original', () => {
    const sobre = cipher.encrypt(TENANT_A, 'secreto-de-firma-de-rappi');
    expect(cipher.decrypt(TENANT_A, sobre)).toBe('secreto-de-firma-de-rappi');
  });

  it('el texto en claro NO aparece en el sobre', () => {
    const secreto = 'secreto-muy-reconocible';
    const sobre = cipher.encrypt(TENANT_A, secreto);
    expect(JSON.stringify(sobre)).not.toContain(secreto);
  });

  it('cifrar dos veces el mismo valor da ciphertext distinto (IV aleatorio)', () => {
    // Si coincidieran, un observador de la BD sabría qué tenants comparten
    // secreto sin descifrar nada.
    const a = cipher.encrypt(TENANT_A, 'mismo-valor');
    const b = cipher.encrypt(TENANT_A, 'mismo-valor');
    expect(a.ct).not.toBe(b.ct);
    expect(cipher.decrypt(TENANT_A, a)).toBe(cipher.decrypt(TENANT_A, b));
  });

  it('AISLAMIENTO: el tenant B no puede descifrar la credencial del tenant A', () => {
    const sobre = cipher.encrypt(TENANT_A, 'secreto-solo-de-A');
    expect(() => cipher.decrypt(TENANT_B, sobre)).toThrow(
      CredentialCipherError,
    );
  });

  it('mover el sobre a otra fila lo invalida (el tenant va como AAD)', () => {
    // Escenario real: alguien con acceso de escritura a la BD copia el
    // ciphertext del tenant A a la conexión del tenant B para firmar webhooks
    // en su nombre. La etiqueta de autenticación lo impide.
    const robado = cipher.encrypt(TENANT_A, 'secreto-solo-de-A');
    expect(() => cipher.decrypt(TENANT_B, robado)).toThrow(
      /clave incorrecta o dato alterado/,
    );
  });

  it('alterar un solo byte del ciphertext se detecta', () => {
    const sobre = cipher.encrypt(TENANT_A, 'secreto-integro');
    const bytes = Buffer.from(sobre.ct, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    const manipulado = { ...sobre, ct: bytes.toString('base64') };
    expect(() => cipher.decrypt(TENANT_A, manipulado)).toThrow(
      CredentialCipherError,
    );
  });

  it('otra clave maestra no descifra', () => {
    const sobre = cipher.encrypt(TENANT_A, 'secreto');
    const otro = new CredentialCipher(
      'otra-clave-maestra-distinta-de-mas-de-32-caracteres',
    );
    expect(() => otro.decrypt(TENANT_A, sobre)).toThrow(CredentialCipherError);
  });

  it('una clave maestra corta se rechaza en vez de degradar la seguridad', () => {
    const debil = new CredentialCipher('corta');
    expect(() => debil.encrypt(TENANT_A, 'x')).toThrow(
      /al menos 32 caracteres/,
    );
  });

  it('un sobre malformado no revienta con un error interno', () => {
    expect(() =>
      cipher.decrypt(TENANT_A, { v: 1, iv: '', tag: '', ct: '' }),
    ).toThrow(CredentialCipherError);
    expect(isEncryptedField({ v: 2, iv: 'a', tag: 'b', ct: 'c' })).toBe(false);
    expect(isEncryptedField(null)).toBe(false);
    expect(isEncryptedField('texto')).toBe(false);
  });

  it('encryptAll y decryptField trabajan por nombre de campo', () => {
    const creds = cipher.encryptAll(TENANT_A, {
      signing_secret: 'firma-1',
      api_key: 'clave-2',
    });
    expect(cipher.decryptField(TENANT_A, creds, 'signing_secret')).toBe(
      'firma-1',
    );
    expect(cipher.decryptField(TENANT_A, creds, 'api_key')).toBe('clave-2');
    expect(() => cipher.decryptField(TENANT_A, creds, 'inexistente')).toThrow(
      /no tiene la credencial/,
    );
  });
});

describe('Redacción antes de salir de la BD', () => {
  it('sustituye los valores pero conserva los nombres', () => {
    const cipher = new CredentialCipher(CLAVE);
    const conexion = {
      id: 'abc',
      provider: 'rappi',
      credentials: cipher.encryptAll(TENANT_A, {
        signing_secret: 'no-debe-salir-jamas',
      }),
    };
    const seguro = redactCredentials(conexion);
    expect(seguro.credentials).toEqual({ signing_secret: '***' });
    expect(JSON.stringify(seguro)).not.toContain('no-debe-salir-jamas');
    // El resto de la conexión sigue siendo legible: redactar no es ocultar.
    expect(seguro.provider).toBe('rappi');
  });

  it('tolera una conexión sin credenciales', () => {
    const sinCredenciales = { id: 'x' };
    expect(redactCredentials(sinCredenciales).credentials).toEqual({});
  });
});

describe('Comparación de firmas', () => {
  it('compara correctamente', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('longitudes distintas no revientan', () => {
    // timingSafeEqual lanza si difieren en longitud; el envoltorio lo filtra.
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
