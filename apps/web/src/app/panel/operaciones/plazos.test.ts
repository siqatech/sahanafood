import { describe, it, expect } from 'vitest';
import { politicaPara, limiteDeRechazo, POLITICA_POR_DEFECTO } from './plazos';
import type { PoliticaDeAceptacion } from '../../../lib/panel-api';

/**
 * El reloj de la torre de control tiene que decir lo MISMO que el barrido.
 *
 * Es una copia de la resolución por especificidad del servidor
 * (`acceptance-policy.ts`), y una copia que se desvía es peor que no tener
 * reloj: el operador ve «te quedan 4 minutos» sobre un pedido que el barrido ya
 * rechazó, y se entera cuando llama el cliente.
 *
 * Estos casos son exactamente los que distinguen una resolución correcta de una
 * que «funciona con los datos de hoy»: la de marca gana a la de canal, y la
 * global solo manda cuando no hay nada más.
 */

const MARCA = 'marca-a';
const OTRA = 'marca-b';

function politica(
  brandId: string | null,
  channel: string | null,
  autoRejectAfterMinutes: number,
): PoliticaDeAceptacion {
  return {
    brandId,
    channel,
    autoAccept: false,
    alertAfterMinutes: 5,
    autoRejectAfterMinutes,
  };
}

describe('Resolución de la política de aceptación', () => {
  it('sin ninguna política vale la de la spec: rechazo a los 10 min', () => {
    expect(politicaPara([], MARCA, 'rappi')).toEqual(POLITICA_POR_DEFECTO);
    expect(POLITICA_POR_DEFECTO.autoRejectAfterMinutes).toBe(10);
  });

  it('la más específica gana: (marca, canal) por encima de todo', () => {
    const resuelta = politicaPara(
      [
        politica(null, null, 10),
        politica(null, 'rappi', 20),
        politica(MARCA, null, 30),
        politica(MARCA, 'rappi', 40),
      ],
      MARCA,
      'rappi',
    );
    expect(resuelta.autoRejectAfterMinutes).toBe(40);
  });

  it('la de MARCA gana a la de canal, igual que en el servidor', () => {
    // Es el caso que más fácil se implementa al revés, y el que más se nota:
    // una marca con cocina lenta se configura una vez y no debería perderla
    // porque alguien añada después una regla de canal.
    const resuelta = politicaPara(
      [politica(null, 'rappi', 20), politica(MARCA, null, 30)],
      MARCA,
      'rappi',
    );
    expect(resuelta.autoRejectAfterMinutes).toBe(30);
  });

  it('una política de OTRA marca no se aplica nunca', () => {
    const resuelta = politicaPara(
      [politica(OTRA, 'rappi', 99)],
      MARCA,
      'rappi',
    );
    expect(resuelta).toEqual(POLITICA_POR_DEFECTO);
  });

  it('una política de otro canal tampoco', () => {
    const resuelta = politicaPara(
      [politica(MARCA, 'pedidosya', 99)],
      MARCA,
      'rappi',
    );
    expect(resuelta).toEqual(POLITICA_POR_DEFECTO);
  });
});

describe('Plazo de rechazo automático', () => {
  it('cuenta desde que ENTRÓ el pedido, no desde que se abrió la pantalla', () => {
    // Si contara desde que se pinta, un pedido de hace nueve minutos aparecería
    // con diez por delante y nadie llegaría a tiempo.
    const entro = '2026-08-09T12:00:00.000Z';
    expect(limiteDeRechazo(entro, politica(null, null, 10))).toBe(
      '2026-08-09T12:10:00.000Z',
    );
  });

  it('respeta el plazo configurado y no el de por defecto', () => {
    const entro = '2026-08-09T12:00:00.000Z';
    expect(limiteDeRechazo(entro, politica(MARCA, 'rappi', 25))).toBe(
      '2026-08-09T12:25:00.000Z',
    );
  });
});
