import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  resolveDocumentType,
  assertValidIdentity,
  assertValidSeries,
  formatDocumentNumber,
  BillingError,
  type CustomerIdentity,
} from './document-type.js';
import {
  checkDeferredIssuance,
  deferredQueueOrder,
  DEFAULT_DEFERRAL_POLICY,
} from './deferred.js';

/**
 * Esto vive en el dominio porque el POS tiene que llegar a la MISMA conclusión
 * sin red. Si la caja dice «boleta» y el servidor dice «factura», el papel que
 * se lleva el cliente no coincide con lo que se declara a SUNAT: no es un bug
 * de interfaz, es un problema tributario.
 */

const conRuc: CustomerIdentity = {
  docType: 'RUC',
  docNumber: '20123456789',
  legalName: 'Constructora Los Andes S.A.C.',
};

describe('Tipo de comprobante', () => {
  it('con RUC es factura; con cualquier otra cosa, boleta', () => {
    expect(resolveDocumentType(conRuc)).toBe('factura');
    expect(resolveDocumentType({ docType: 'DNI', docNumber: '45678912' })).toBe(
      'boleta',
    );
    expect(resolveDocumentType({ docType: 'NONE' })).toBe('boleta');
    expect(
      resolveDocumentType({ docType: 'CE', docNumber: '001234567890' }),
    ).toBe('boleta');
  });

  it('la venta al público SIN identificar se factura igual', () => {
    // Negarse a emitir por falta de documento del cliente pararía la caja.
    expect(() => assertValidIdentity({ docType: 'NONE' })).not.toThrow();
    expect(resolveDocumentType({ docType: 'NONE' })).toBe('boleta');
  });
});

describe('Validación de identidad del receptor', () => {
  it('exige la longitud exacta del catálogo de SUNAT', () => {
    // Un RUC de 10 dígitos aceptado sin red es un comprobante que el OSE
    // rechazará horas después, con el cliente ya fuera del local.
    expect(() =>
      assertValidIdentity({ ...conRuc, docNumber: '2012345678' }),
    ).toThrow(/11 caracteres/);
    expect(() =>
      assertValidIdentity({ docType: 'DNI', docNumber: '1234567' }),
    ).toThrow(/8 caracteres/);
    expect(() =>
      assertValidIdentity({ docType: 'DNI', docNumber: '45678912' }),
    ).not.toThrow();
  });

  it('el pasaporte no tiene longitud fija, pero sí formato', () => {
    expect(() =>
      assertValidIdentity({ docType: 'PASAPORTE', docNumber: 'XA1234' }),
    ).not.toThrow();
    expect(() =>
      assertValidIdentity({ docType: 'PASAPORTE', docNumber: 'XA-1234' }),
    ).toThrow(/letras y dígitos/);
  });

  it('DNI y RUC son solo dígitos', () => {
    expect(() =>
      assertValidIdentity({ docType: 'DNI', docNumber: '4567891A' }),
    ).toThrow(/solo dígitos/);
  });

  it('una FACTURA sin razón social se rechaza aquí, no en el OSE', () => {
    // Sin razón social SUNAT la rechaza y el cliente se queda sin su crédito
    // fiscal, que es justo por lo que pidió factura.
    expect(() =>
      assertValidIdentity({ ...conRuc, legalName: undefined }),
    ).toThrow(/razón social/);
    expect(() => assertValidIdentity({ ...conRuc, legalName: '  ' })).toThrow(
      /razón social/,
    );
  });

  it('un número sin tipo es un dato a medias', () => {
    expect(() =>
      assertValidIdentity({ docType: 'NONE', docNumber: '45678912' }),
    ).toThrow(/no se indicó de qué tipo/);
  });

  it('los errores traen código estable para que el POS decida sin leer texto', () => {
    try {
      assertValidIdentity({ docType: 'RUC', docNumber: '123' });
    } catch (e) {
      expect(e).toBeInstanceOf(BillingError);
      expect((e as BillingError).code).toBe('BILLING_DOC_NUMBER_INVALID');
    }
  });
});

describe('Series y numeración', () => {
  it('rellena el correlativo a 8 dígitos', () => {
    // «B001-42» pasa cualquier validación local y lo rechaza el OSE.
    expect(formatDocumentNumber('B001', 42)).toBe('B001-00000042');
    expect(formatDocumentNumber('F001', 12345678)).toBe('F001-12345678');
  });

  it('rechaza correlativos que no son enteros positivos', () => {
    for (const malo of [0, -1, 1.5]) {
      expect(() => formatDocumentNumber('B001', malo)).toThrow(BillingError);
    }
  });

  it('la factura va en serie F y la boleta en serie B', () => {
    // Una serie con el prefijo equivocado es un rechazo garantizado, y se
    // descubre con la venta ya cobrada.
    expect(() => assertValidSeries('F001', 'factura')).not.toThrow();
    expect(() => assertValidSeries('B001', 'boleta')).not.toThrow();
    expect(() => assertValidSeries('B001', 'factura')).toThrow(
      /empiece por "F"/,
    );
    expect(() => assertValidSeries('F001', 'boleta')).toThrow(
      /empiece por "B"/,
    );
  });

  it('la nota de crédito hereda la letra del documento que corrige', () => {
    expect(() => assertValidSeries('F001', 'nota_credito')).not.toThrow();
    expect(() => assertValidSeries('B001', 'nota_credito')).not.toThrow();
  });

  it('rechaza series con formato imposible', () => {
    for (const mala of ['001', 'FF', 'F00001', 'X001', 'f001']) {
      expect(() => assertValidSeries(mala, 'factura')).toThrow(BillingError);
    }
  });
});

describe('Emisión diferida (RN-BIL-03)', () => {
  const emision = new Date('2026-08-07T10:00:00Z');
  const mas = (horas: number) =>
    new Date(emision.getTime() + horas * 3_600_000);

  it('cuenta desde la EMISIÓN REAL, no desde el intento de envío', () => {
    // Contar desde el envío haría que un documento con tres días de retraso
    // pareciera recién nacido: es el error que oculta el problema hasta que ya
    // no tiene arreglo.
    const r = checkDeferredIssuance(emision, mas(30));
    expect(r.ageHours).toBeCloseTo(30, 5);
    expect(r.hoursRemaining).toBeCloseTo(42, 5);
    expect(r.status).toBe('ok');
  });

  it('avisa ANTES de vencer, con tiempo de reaccionar', () => {
    // Avisar al vencer no es avisar, es informar de un incumplimiento.
    expect(checkDeferredIssuance(emision, mas(47)).status).toBe('ok');
    expect(checkDeferredIssuance(emision, mas(49)).status).toBe('warning');
    expect(checkDeferredIssuance(emision, mas(71)).status).toBe('warning');
  });

  it('marca vencido al pasar el límite', () => {
    expect(checkDeferredIssuance(emision, mas(72)).status).toBe('expired');
    expect(
      checkDeferredIssuance(emision, mas(100)).hoursRemaining,
    ).toBeLessThan(0);
  });

  it('un reloj adelantado en la caja no bloquea el comprobante', () => {
    // La venta ya ocurrió; no la vamos a parar por la hora de una tablet.
    const r = checkDeferredIssuance(emision, mas(-5));
    expect(r.ageHours).toBe(0);
    expect(r.status).toBe('ok');
  });

  it('rechaza políticas que harían la alerta inútil', () => {
    // Una alerta que siempre está encendida es una alerta que nadie mira.
    expect(() =>
      checkDeferredIssuance(emision, mas(1), {
        limitHours: 24,
        warnBeforeHours: 24,
      }),
    ).toThrow(/antes del límite/);
    expect(() =>
      checkDeferredIssuance(emision, mas(1), {
        limitHours: 0,
        warnBeforeHours: 0,
      }),
    ).toThrow(/límite positivo/);
  });

  it('la cola despacha lo MÁS ANTIGUO primero', () => {
    // La tentación es despachar lo que acaba de entrar —es lo que el operador
    // mira— y es al revés: el viejo es el único que puede vencer.
    const cola = [
      { id: 'nuevo', emittedAt: mas(10) },
      { id: 'viejo', emittedAt: mas(0) },
      { id: 'medio', emittedAt: mas(5) },
    ];
    expect(deferredQueueOrder(cola).map((d) => d.id)).toEqual([
      'viejo',
      'medio',
      'nuevo',
    ]);
  });

  it('ordenar no muta la lista original', () => {
    const cola = [{ emittedAt: mas(10) }, { emittedAt: mas(0) }];
    const original = [...cola];
    deferredQueueOrder(cola);
    expect(cola).toEqual(original);
  });
});

describe('Facturación — propiedades', () => {
  it('el número siempre trae serie y 8 dígitos', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99_999_999 }), (n) => {
        const numero = formatDocumentNumber('F001', n);
        expect(numero).toMatch(/^F001-\d{8}$/);
        expect(Number(numero.split('-')[1])).toBe(n);
      }),
    );
  });

  it('el estado diferido es monótono: el tiempo nunca mejora la situación', () => {
    // Si a las 30 h está en aviso, a las 40 no puede estar «ok».
    const orden = { ok: 0, warning: 1, expired: 2 };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        (a, b) => {
          const [antes, despues] = a <= b ? [a, b] : [b, a];
          const e1 = checkDeferredIssuance(
            new Date('2026-08-07T10:00:00Z'),
            new Date(
              new Date('2026-08-07T10:00:00Z').getTime() + antes * 3_600_000,
            ),
          ).status;
          const e2 = checkDeferredIssuance(
            new Date('2026-08-07T10:00:00Z'),
            new Date(
              new Date('2026-08-07T10:00:00Z').getTime() + despues * 3_600_000,
            ),
          ).status;
          expect(orden[e2]).toBeGreaterThanOrEqual(orden[e1]);
        },
      ),
    );
  });

  it('un DNI válido nunca produce factura', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{8}$/), (dni) => {
        const identidad: CustomerIdentity = { docType: 'DNI', docNumber: dni };
        expect(() => assertValidIdentity(identidad)).not.toThrow();
        expect(resolveDocumentType(identidad)).toBe('boleta');
      }),
    );
  });

  it('la política por defecto es coherente consigo misma', () => {
    expect(DEFAULT_DEFERRAL_POLICY.warnBeforeHours).toBeLessThan(
      DEFAULT_DEFERRAL_POLICY.limitHours,
    );
  });
});
