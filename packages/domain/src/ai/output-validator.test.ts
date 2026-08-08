import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  validateOutput,
  extractFacts,
  type ToolEvidence,
} from './output-validator.js';

/**
 * Prueba ADVERSARIAL del validador (RN-AIA-01, T5.24).
 *
 * No se prueba «el validador funciona con la respuesta buena». Se prueba
 * intentando colar un precio inventado de todas las formas en que un modelo lo
 * diría de verdad: con símbolo y sin él, redondeando, en medio de una frase
 * larga, mezclado con un precio que sí consultó.
 */

/** El agente consultó el catálogo: pollo a S/ 32,00. */
const PRECIO_CONSULTADO: ToolEvidence = {
  tool: 'catalog.search',
  kinds: ['price'],
  values: ['320000'], // 32,00 en céntimos de escala 4
};

const COBERTURA_CONSULTADA: ToolEvidence = {
  tool: 'org.coverage',
  kinds: ['coverage'],
  values: [],
};

describe('Validador de salida del agente (RN-AIA-01, T5.24)', () => {
  it('una respuesta sin datos duros pasa', () => {
    const v = validateOutput('¡Hola! ¿En qué te puedo ayudar hoy?', []);
    expect(v.ok).toBe(true);
  });

  it('el precio CONSULTADO pasa', () => {
    const v = validateOutput(
      'El pollo a la brasa entero cuesta S/ 32.00.',
      [PRECIO_CONSULTADO],
    );
    expect(v.ok).toBe(true);
  });

  // ------------------------------------------------------- Adversariales

  it('ADVERSARIAL: precio inventado sin haber consultado nada', () => {
    const v = validateOutput('El pollo cuesta S/ 28.00.', []);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('UNSUPPORTED_FACT');
      expect(v.reason).toContain('28.00');
    }
  });

  it('ADVERSARIAL: consultó UN precio y cita OTRO', () => {
    // El fallo más probable de todos: el modelo busca el pollo, ve 32, y al
    // redactar cita el de la gaseosa o un número parecido. Una comprobación
    // por TIPO —«¿llamó a una herramienta de precios? sí»— lo dejaría pasar.
    const v = validateOutput(
      'El pollo cuesta S/ 32.00 y la gaseosa S/ 8.00.',
      [PRECIO_CONSULTADO],
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('8.00');
  });

  it('ADVERSARIAL: REDONDEA el precio consultado', () => {
    // «Unos 30 soles» suena inofensivo y es un precio distinto al real.
    const v = validateOutput('Está en unos 30 soles.', [PRECIO_CONSULTADO]);
    expect(v.ok).toBe(false);
  });

  it('ADVERSARIAL: el precio escondido en una frase larga', () => {
    const v = validateOutput(
      'Mira, tenemos varias opciones muy ricas para compartir en familia, ' +
        'y la que más sale es el combo, que te sale S/ 45.90 con gaseosa incluida.',
      [PRECIO_CONSULTADO],
    );
    expect(v.ok).toBe(false);
  });

  it('ADVERSARIAL: promete stock sin consultarlo', () => {
    const v = validateOutput('Sí tenemos, te lo mando enseguida.', []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.unsupported.some((f) => f.kind === 'stock')).toBe(true);
  });

  it('ADVERSARIAL: promete llegar sin consultar cobertura', () => {
    const v = validateOutput('Claro que llegamos a tu zona.', []);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.unsupported.some((f) => f.kind === 'coverage')).toBe(true);
    }
  });

  it('la cobertura CONSULTADA pasa', () => {
    const v = validateOutput('Sí llegamos a tu zona.', [COBERTURA_CONSULTADA]);
    expect(v.ok).toBe(true);
  });

  it('ADVERSARIAL: inventa un horario', () => {
    const v = validateOutput('Abrimos de 11 am a 11 pm.', []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.unsupported.some((f) => f.kind === 'hours')).toBe(true);
  });

  // ----------------------------------------------------- Guardrails fijos

  it('bloquea una promoción inventada aunque tenga el precio bien', () => {
    const v = validateOutput(
      'Tengo un descuento exclusivo que te doy: S/ 32.00.',
      [PRECIO_CONSULTADO],
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('FORBIDDEN_TOPIC');
  });

  it('bloquea una promesa legal', () => {
    const v = validateOutput('Te garantizo que llega en 20 minutos.', []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('FORBIDDEN_TOPIC');
  });

  it('un tema vedado propio del tenant también bloquea', () => {
    const v = validateOutput('Trabajamos con la competencia también.', [], {
      forbiddenTopics: ['la competencia'],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('FORBIDDEN_TOPIC');
  });

  it('el tema vedado gana sobre el dato sin respaldo', () => {
    // Una respuesta prohibida no mejora por estar bien respaldada, así que se
    // comprueba antes: el motivo que se registra tiene que ser el de fondo.
    const v = validateOutput('Te garantizo que cuesta S/ 99.00.', []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('FORBIDDEN_TOPIC');
  });

  it('una respuesta demasiado larga se bloquea', () => {
    const v = validateOutput('hola '.repeat(400), []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('TOO_LONG');
  });

  // --------------------------------------------------------- Propiedades

  it('PROPIEDAD: ningún importe pasa sin estar en la evidencia', () => {
    // La invariante que sostiene RN-AIA-01. Si esto falla, hay una forma de
    // escribir un precio que el validador no ve.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 0, max: 99 }),
        (entero, decimal) => {
          const texto = `Cuesta S/ ${entero}.${String(decimal).padStart(2, '0')}`;
          const v = validateOutput(texto, [PRECIO_CONSULTADO]);
          const centimos = String(
            Math.round(Number(`${entero}.${String(decimal).padStart(2, '0')}`) * 10_000),
          );
          // Pasa si y solo si el importe es EXACTAMENTE el consultado.
          expect(v.ok).toBe(centimos === '320000');
        },
      ),
      { numRuns: 400 },
    );
  });

  it('PROPIEDAD: el extractor es estable entre llamadas', () => {
    // Los regex globales guardan `lastIndex` entre usos; uno sucio se salta
    // coincidencias de forma intermitente, que es el peor modo de fallo posible
    // en un validador: pasa unas veces sí y otras no.
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (texto) => {
        const primera = extractFacts(texto);
        const segunda = extractFacts(texto);
        expect(segunda).toEqual(primera);
      }),
      { numRuns: 300 },
    );
  });
});
