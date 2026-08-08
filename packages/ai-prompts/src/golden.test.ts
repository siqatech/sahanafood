import { describe, it, expect } from 'vitest';
import {
  GOLDEN_DIALOGUES,
  compareGolden,
  formatFailures,
  type GoldenResult,
} from './golden.js';

/** Corrida perfecta: cada turno resuelto como manda la referencia. */
function corridaPerfecta(): GoldenResult[] {
  return GOLDEN_DIALOGUES.flatMap((d) =>
    d.turns.map((t, i) => ({
      dialogueId: d.id,
      turnIndex: i,
      resolution: t.expect,
      toolsCalled: t.tools ?? [],
      actionKinds: t.actionKinds ?? [],
      text: 'respuesta correcta',
    })),
  );
}

describe('Suite de conversaciones doradas (T5.31)', () => {
  it('la referencia tiene 20+ diálogos y cubre varios rubros', () => {
    // El criterio del backlog es 20+. Se comprueba aquí para que reducir la
    // suite sea un test en rojo y no un diff que pasa desapercibido.
    expect(GOLDEN_DIALOGUES.length).toBeGreaterThanOrEqual(20);
    expect(
      new Set(GOLDEN_DIALOGUES.map((d) => d.vertical)).size,
    ).toBeGreaterThanOrEqual(3);
    // Ids únicos: dos diálogos con el mismo id harían que el comparador leyera
    // el resultado del otro y aprobara una regresión.
    expect(new Set(GOLDEN_DIALOGUES.map((d) => d.id)).size).toBe(
      GOLDEN_DIALOGUES.length,
    );
    // Cada turno explica POR QUÉ está: sin eso, quien lo vea fallar dentro de
    // seis meses no sabrá si arreglarlo o borrarlo.
    for (const d of GOLDEN_DIALOGUES) {
      for (const t of d.turns) expect(t.why.length).toBeGreaterThan(20);
    }
  });

  it('una corrida perfecta no tiene fallos', () => {
    expect(compareGolden(GOLDEN_DIALOGUES, corridaPerfecta())).toEqual([]);
  });

  it('DETECTA que una regla pasó a costar tokens', () => {
    // La regresión más cara y más silenciosa: la respuesta sigue siendo
    // correcta, pero ahora se paga por ella en cada conversación.
    const corrida = corridaPerfecta().map((r) =>
      r.dialogueId === 'polleria-horario' ? { ...r, resolution: 'llm' } : r,
    );
    const fallos = compareGolden(GOLDEN_DIALOGUES, corrida);
    expect(fallos).toHaveLength(1);
    expect(fallos[0]!.detail).toContain('"rule"');
    expect(formatFailures(fallos)).toContain('Por qué importa');
  });

  it('DETECTA que dejó de consultarse el catálogo para un precio', () => {
    const corrida = corridaPerfecta().map((r) =>
      r.dialogueId === 'polleria-precio' ? { ...r, toolsCalled: [] } : r,
    );
    const fallos = compareGolden(GOLDEN_DIALOGUES, corrida);
    expect(fallos.some((f) => f.detail.includes('catalog.search'))).toBe(true);
  });

  it('DETECTA una promesa prohibida en la respuesta', () => {
    const corrida = corridaPerfecta().map((r) =>
      r.dialogueId === 'polleria-reclamo'
        ? { ...r, text: 'Claro, te devolvemos el dinero enseguida.' }
        : r,
    );
    const fallos = compareGolden(GOLDEN_DIALOGUES, corrida);
    expect(fallos.some((f) => f.detail.includes('te devolvemos'))).toBe(true);
  });

  it('DETECTA que una regla dejó de derivar', () => {
    // La regla de alergias responde Y deriva. Si alguien le quita el traspaso,
    // la resolución sigue siendo `rule` y todo parece bien: esto es lo único
    // que lo ve.
    const corrida = corridaPerfecta().map((r) =>
      r.dialogueId === 'chifa-alergias' ? { ...r, actionKinds: ['reply'] } : r,
    );
    const fallos = compareGolden(GOLDEN_DIALOGUES, corrida);
    expect(fallos.some((f) => f.detail.includes('handoff'))).toBe(true);
  });

  it('DETECTA un turno que no llegó a ejecutarse', () => {
    // Un diálogo que se cae a mitad no puede contar como aprobado.
    const corrida = corridaPerfecta().filter(
      (r) => !(r.dialogueId === 'chifa-varios-turnos' && r.turnIndex === 2),
    );
    const fallos = compareGolden(GOLDEN_DIALOGUES, corrida);
    expect(fallos.some((f) => f.detail.includes('no se ejecutó'))).toBe(true);
  });
});
