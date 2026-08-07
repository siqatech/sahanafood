import { expect } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

/**
 * Harness reutilizable de aislamiento por endpoint (T3.13, docs/09 §6).
 *
 * La regla del proyecto es que **todo endpoint nuevo necesita su prueba de
 * aislamiento** o el PR no se aprueba. Escribir esa prueba a mano para cada
 * endpoint es repetitivo y —lo importante— solo comprueba lo que al autor se le
 * ocurrió comprobar.
 *
 * Este harness invierte el enfoque: en vez de afirmar «el campo X no debe traer
 * el id del otro tenant», **recorre la respuesta entera** buscando CUALQUIER
 * identificador conocido del tenant ajeno, a cualquier profundidad. Así detecta
 * fugas en campos que nadie pensó en revisar: un id anidado en un objeto de
 * relación, un uuid dentro de un jsonb, un nombre en una lista.
 *
 * Uso desde la suite de un módulo:
 *
 *   await assertEndpointIsolation(app, {
 *     name: 'GET /coverage',
 *     request: (r) => r.get('/api/v1/coverage?lat=-12.12&lng=-77.02'),
 *     tokenA, tokenB,
 *     secretsOfB: [tenantB.zoneId, tenantB.companyId, 'Tenant B'],
 *   });
 */

/** Agente HTTP de pruebas, tal como lo devuelve `supertest(app)`. */
type TestAgent = ReturnType<typeof request>;

export interface IsolationCase {
  /** Nombre legible para el mensaje de error. */
  name: string;
  /** Construye la petición (sin cabecera de autorización). */
  request: (agent: TestAgent) => request.Test;
  /** Token del tenant que SÍ debe ver el recurso. */
  tokenA: string;
  /** Token de otro tenant, para comprobar que ve algo distinto (o nada). */
  tokenB?: string;
  /**
   * Valores que pertenecen al OTRO tenant y que jamás deben aparecer en la
   * respuesta de A: ids, nombres, slugs, correos.
   */
  secretsOfB: readonly string[];
  /** Códigos aceptables para A (por defecto 200). Útil si el recurso puede no existir. */
  expectedStatusForA?: readonly number[];
  /** Si el endpoint es público, se omiten las comprobaciones de autenticación. */
  isPublic?: boolean;
}

/** Aplana cualquier valor JSON a una lista de cadenas, a cualquier profundidad. */
function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (value === null || value === undefined) return acc;
  if (typeof value === 'string') {
    acc.push(value);
    return acc;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    acc.push(String(value));
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, acc);
    return acc;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.push(k);
      collectStrings(v, acc);
    }
  }
  return acc;
}

/**
 * Ejecuta las comprobaciones de aislamiento sobre un endpoint.
 * Lanza con un mensaje explícito si alguna falla.
 */
export async function assertEndpointIsolation(
  app: INestApplication,
  testCase: IsolationCase,
): Promise<void> {
  const agent = (): TestAgent => request(app.getHttpServer());
  const okStatuses = testCase.expectedStatusForA ?? [200];

  // 1) Sin token: un endpoint protegido no puede responder con datos.
  if (!testCase.isPublic) {
    const anon = await testCase.request(agent());
    expect(
      [401, 403],
      `${testCase.name}: sin token debería responder 401/403, respondió ${anon.status}`,
    ).toContain(anon.status);
  }

  // 2) Token manipulado: la firma debe rechazarse.
  if (!testCase.isPublic) {
    const tampered = await testCase
      .request(agent())
      .set('authorization', `Bearer ${testCase.tokenA}.manipulado`);
    expect(
      [401, 403],
      `${testCase.name}: un token manipulado debería rechazarse, respondió ${tampered.status}`,
    ).toContain(tampered.status);
  }

  // 3) Con el token de A: la respuesta no puede contener NADA del tenant B.
  const asA = await testCase
    .request(agent())
    .set('authorization', `Bearer ${testCase.tokenA}`);

  expect(
    okStatuses,
    `${testCase.name}: el tenant propietario debería obtener ${okStatuses.join('/')}, obtuvo ${asA.status}`,
  ).toContain(asA.status);

  const haystack = collectStrings(asA.body);
  const leaked = testCase.secretsOfB.filter((secret) =>
    haystack.some((s) => s === secret || s.includes(secret)),
  );

  expect(
    leaked,
    `FUGA DE AISLAMIENTO en ${testCase.name}: la respuesta del tenant A contiene ` +
      `datos del tenant B (${leaked.join(', ')}). Respuesta: ${JSON.stringify(asA.body).slice(0, 500)}`,
  ).toEqual([]);

  // 4) Con el token de B: tampoco puede ver lo de A (simetría).
  if (testCase.tokenB) {
    const asB = await testCase
      .request(agent())
      .set('authorization', `Bearer ${testCase.tokenB}`);
    // B puede legítimamente obtener 404 (no tiene el recurso) o 200 con lo suyo.
    if (asB.status === 200) {
      const bodyB = JSON.stringify(asB.body);
      const bodyA = JSON.stringify(asA.body);
      expect(
        bodyB === bodyA && bodyA !== '{}' && bodyA !== '[]',
        `${testCase.name}: los tenants A y B reciben EXACTAMENTE la misma respuesta, ` +
          'lo que sugiere que el endpoint no filtra por tenant.',
      ).toBe(false);
    }
  }
}

/** Aplica el harness a una lista de endpoints. */
export async function assertIsolationSuite(
  app: INestApplication,
  cases: readonly IsolationCase[],
): Promise<void> {
  for (const testCase of cases) {
    await assertEndpointIsolation(app, testCase);
  }
}
