import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_REQUIREMENTS,
  AUDIT_REQUIREMENTS_PENDING,
} from './app/audit.service.js';

/**
 * El contrato de auditoría tiene que tener quien lo escriba.
 *
 * CLAUDE.md dice que la deuda que toca **auditoría no es aceptable nunca**, y
 * hasta ahora eso descansaba en una lista de nombres que no comprobaba nadie:
 * `AUDITED_ACTIONS` enumeraba `price.changed`, `permissions.changed` y
 * `order.refunded`, y el código escribía `catalog.price_set`,
 * `identity.role_changed` y `payment.refunded`. Diez de diecisiete nombres no
 * los emitía nadie.
 *
 * Eso no se nota nunca por sí solo: **nadie echa de menos una línea de
 * auditoría que no sabe que debería existir.** Se nota el día que hay que
 * demostrar quién cambió un precio, y ya es tarde.
 *
 * Esta prueba es barata a propósito —lee el código fuente y busca el nombre—
 * porque su valor no está en la profundidad sino en que **falla en el momento
 * en que alguien renombra una acción y deja el requisito huérfano**. Que la
 * acción se emita de verdad en el flujo lo comprueban las e2e de cada módulo.
 */

const MODULOS = join(dirname(fileURLToPath(import.meta.url)), '..');

async function fuentesDeModulos(): Promise<string> {
  const partes: string[] = [];
  const recorrer = async (dir: string): Promise<void> => {
    for (const entrada of await readdir(dir, { withFileTypes: true })) {
      const ruta = join(dir, entrada.name);
      if (entrada.isDirectory()) {
        await recorrer(ruta);
      } else if (
        entrada.name.endsWith('.ts') &&
        !entrada.name.endsWith('.test.ts') &&
        // El propio contrato NO cuenta como emisor. Sin esta línea la prueba
        // se aprueba a sí misma: el nombre aparece en el mapa de requisitos y
        // pasaría aunque no lo escribiera nadie.
        entrada.name !== 'audit.service.ts'
      ) {
        partes.push(await readFile(ruta, 'utf8'));
      }
    }
  };
  await recorrer(MODULOS);
  return partes.join('\n');
}

describe('Contrato de auditoría (docs/14#auditoria)', () => {
  it('CADA REQUISITO tiene al menos una acción que alguien escribe', async () => {
    const fuente = await fuentesDeModulos();
    const huerfanos: string[] = [];

    for (const [requisito, acciones] of Object.entries(AUDIT_REQUIREMENTS)) {
      for (const accion of acciones) {
        // Se busca el nombre entre comillas, que es como se escribe en un
        // `recordAudit`. Un nombre compuesto con plantilla —`cash.${kind}`— no
        // lo encontraría, y por eso el contrato no nombra ninguno de esos.
        if (!fuente.includes(`'${accion}'`)) {
          huerfanos.push(`${requisito} → ${accion}`);
        }
      }
    }

    expect(
      huerfanos,
      `Estos requisitos de auditoría no los escribe nadie:\n${huerfanos.join('\n')}`,
    ).toEqual([]);
  });

  it('LO PENDIENTE está declarado con su motivo, no omitido', () => {
    // Una lista que solo contenga lo ya hecho no distingue «cumplido» de
    // «olvidado». Estos dos requisitos de docs/14 no tienen emisor porque la
    // funcionalidad no existe, y eso se dice en vez de callarse.
    for (const [requisito, motivo] of Object.entries(
      AUDIT_REQUIREMENTS_PENDING,
    )) {
      expect(motivo.length, `${requisito} sin motivo`).toBeGreaterThan(20);
    }
    expect(Object.keys(AUDIT_REQUIREMENTS_PENDING)).toEqual([
      'support.cross_tenant_access',
      'data.bulk_export',
    ]);
  });

  it('NINGÚN REQUISITO se queda sin acciones', () => {
    // Un requisito con la lista vacía pasaría el primer test sin comprobar
    // nada: es la forma silenciosa de saltarse el contrato.
    for (const [requisito, acciones] of Object.entries(AUDIT_REQUIREMENTS)) {
      expect(
        acciones.length,
        `${requisito} no nombra ninguna acción`,
      ).toBeGreaterThan(0);
    }
  });
});
