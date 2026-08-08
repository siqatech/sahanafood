import { describe, it, expect } from 'vitest';
import {
  matchRule,
  detectNegativeSentiment,
  type DeterministicRule,
} from './deterministic-actions.js';
import { checkAiBudget, creditsForTokens, WARNING_RATIO } from './budget.js';

const regla = (over: Partial<DeterministicRule> = {}): DeterministicRule => ({
  id: 'r1',
  name: 'Horario',
  priority: 10,
  match: 'any',
  conditions: [{ kind: 'asks_about', value: 'horario, hora, abren' }],
  actions: [{ kind: 'reply', value: 'Abrimos de 11:00 a 23:00.' }],
  enabled: true,
  ...over,
});

describe('Acciones deterministas (spec 19 §2.3, T5.25)', () => {
  it('dispara por tema y devuelve la acción configurada', () => {
    const m = matchRule([regla()], { text: '¿A qué hora abren hoy?' });
    expect(m?.actions[0]!.value).toContain('11:00');
    // La traza dice QUÉ disparó: sin eso, discutir con el dueño por qué su
    // regla no saltó es imposible (RN-AIA-05).
    expect(m?.matchedBy[0]).toContain('asks_about');
  });

  it('GANA la de menor prioridad, y solo dispara UNA', () => {
    // Aplicar todas las coincidentes produciría respuestas apiladas —«nuestro
    // horario es… y además tenemos promoción…»— que es justo lo que hace que
    // un bot parezca un bot.
    const m = matchRule(
      [
        regla({
          id: 'a',
          priority: 20,
          actions: [{ kind: 'reply', value: 'segunda' }],
        }),
        regla({
          id: 'b',
          priority: 5,
          actions: [{ kind: 'reply', value: 'primera' }],
        }),
      ],
      { text: '¿horario?' },
    );
    expect(m?.actions).toHaveLength(1);
    expect(m?.actions[0]!.value).toBe('primera');
  });

  it('a igual prioridad el orden es ESTABLE', () => {
    // Sin desempate, dos reglas empatadas dispararían una u otra según lo que
    // devolviera la base de datos, y el dueño vería su agente responder
    // distinto sin haber cambiado nada.
    const reglas = [
      regla({ id: 'zzz', actions: [{ kind: 'reply', value: 'z' }] }),
      regla({ id: 'aaa', actions: [{ kind: 'reply', value: 'a' }] }),
    ];
    const uno = matchRule(reglas, { text: 'horario' });
    const dos = matchRule([...reglas].reverse(), { text: 'horario' });
    expect(uno?.rule.id).toBe(dos?.rule.id);
    expect(uno?.rule.id).toBe('aaa');
  });

  it('`all` exige TODAS las condiciones', () => {
    const r = regla({
      match: 'all',
      conditions: [
        { kind: 'asks_about', value: 'delivery' },
        { kind: 'contains', value: 'miraflores' },
      ],
    });
    expect(matchRule([r], { text: '¿hacen delivery?' })).toBeNull();
    expect(
      matchRule([r], { text: '¿hacen delivery a Miraflores?' }),
    ).not.toBeNull();
  });

  it('«primera vez» NO dispara la segunda', () => {
    // Repetir la misma respuesta enlatada a quien ya la leyó es la señal más
    // clara de que está hablando con una máquina.
    const r = regla({
      conditions: [{ kind: 'asks_first_time_about', value: 'horario' }],
    });
    expect(matchRule([r], { text: '¿horario?' })).not.toBeNull();
    expect(
      matchRule([r], { text: '¿horario?', askedTopics: ['horario'] }),
    ).toBeNull();
  });

  it('detecta la intención de comprar y la de reclamar', () => {
    const comprar = regla({
      conditions: [{ kind: 'wants', value: 'comprar' }],
      actions: [{ kind: 'reply', value: 'te ayudo a pedir' }],
    });
    expect(matchRule([comprar], { text: 'quiero dos pollos' })).not.toBeNull();

    const reclamo = regla({
      conditions: [{ kind: 'wants', value: 'reclamar' }],
      actions: [{ kind: 'handoff', value: 'reclamo' }],
    });
    const m = matchRule([reclamo], { text: 'mi pedido llegó frío, pésimo' });
    expect(m?.actions[0]!.kind).toBe('handoff');
  });

  it('un reclamo se detecta sin modelo (RN-AIA-03)', () => {
    // Esto decide si una queja llega a un humano: tiene que funcionar con el
    // presupuesto agotado y sin red.
    expect(detectNegativeSentiment('quiero una devolución')).toBe(true);
    expect(detectNegativeSentiment('el pollo no llegó')).toBe(true);
    expect(detectNegativeSentiment('¿tienen pollo?')).toBe(false);
  });

  it('detecta la queja con CONCORDANCIA de género y número', () => {
    // El reclamo literal de una pizzería. El patrón solo cubría «frío», así
    // que «la pizza llegó fría» pasaba como conversación normal y nadie la
    // atendía.
    expect(detectNegativeSentiment('La pizza llegó fría')).toBe(true);
    expect(detectNegativeSentiment('las papas llegaron frías')).toBe(true);
    expect(detectNegativeSentiment('el pedido llegó incompleto')).toBe(true);
    expect(detectNegativeSentiment('la hamburguesa estaba cruda')).toBe(true);
    expect(detectNegativeSentiment('llegó tarde')).toBe(true);
  });

  it('una consulta de estado NO es un reclamo', () => {
    // «llegó» a secas no puede derivar: gastar a una persona en «¿ya llegó mi
    // pedido?» es justo lo que el agente existe para evitar.
    expect(detectNegativeSentiment('¿ya llegó mi pedido?')).toBe(false);
    expect(detectNegativeSentiment('avísame cuando llegue')).toBe(false);
  });

  it('una regla desactivada no dispara', () => {
    expect(
      matchRule([regla({ enabled: false })], { text: 'horario' }),
    ).toBeNull();
  });

  it('la franja horaria CRUZA MEDIANOCHE', () => {
    // La regla de «fuera de horario» es justo la que más falta hace de noche;
    // sin soportar el cruce, de 23:00 a 02:00 no dispararía nunca.
    const nocturna = regla({
      activeFrom: 23 * 60,
      activeTo: 2 * 60,
      actions: [{ kind: 'reply', value: 'Estamos cerrados.' }],
    });
    expect(
      matchRule([nocturna], { text: 'horario', minuteOfDay: 23 * 60 + 30 }),
    ).not.toBeNull();
    expect(
      matchRule([nocturna], { text: 'horario', minuteOfDay: 60 }),
    ).not.toBeNull();
    expect(
      matchRule([nocturna], { text: 'horario', minuteOfDay: 12 * 60 }),
    ).toBeNull();
  });

  it('sin hora conocida, una regla horaria NO dispara', () => {
    // Dispararla a ciegas podría dar «estamos cerrados» a mediodía.
    const nocturna = regla({ activeFrom: 23 * 60, activeTo: 2 * 60 });
    expect(matchRule([nocturna], { text: 'horario' })).toBeNull();
  });
});

describe('Presupuesto de IA (ADR-0011 §4, T5.30)', () => {
  it('por debajo del 80 % todo va bien', () => {
    const d = checkAiBudget({ limitCredits: 1000, usedCredits: 500 });
    expect(d.state).toBe('ok');
    expect(d.allowLlm).toBe(true);
  });

  it('al 80 % AVISA pero sigue generando', () => {
    // Enterarse al 100 % es enterarse tarde: el dueño necesita margen para
    // decidir si amplía o deja que degrade.
    const d = checkAiBudget({
      limitCredits: 1000,
      usedCredits: WARNING_RATIO * 1000,
    });
    expect(d.state).toBe('warning');
    expect(d.allowLlm).toBe(true);
  });

  it('AGOTADO no deja generar, pero el negocio SIGUE RESPONDIENDO', () => {
    // La regla entera de ADR-0011 §4: un agente que devuelve un error cuando
    // se acaba el saldo es peor que no tener agente.
    const d = checkAiBudget({ limitCredits: 1000, usedCredits: 1000 });
    expect(d.state).toBe('exhausted');
    expect(d.allowLlm).toBe(false);
    expect(d.allowDeterministic).toBe(true);
    expect(d.reason).toContain('acciones configuradas');
  });

  it('un plan sin IA no es un error: es un tenant que no la contrató', () => {
    const d = checkAiBudget({ limitCredits: 0, usedCredits: 0 });
    expect(d.allowLlm).toBe(false);
    expect(d.allowDeterministic).toBe(true);
  });

  it('los créditos se redondean HACIA ARRIBA, y mínimo 1', () => {
    // Cobrar de menos por sistema convierte el presupuesto en una sugerencia.
    const rate = { creditsPerKInput: 1, creditsPerKOutput: 3 };
    expect(creditsForTokens(10, 10, rate)).toBe(1);
    expect(creditsForTokens(1000, 1000, rate)).toBe(4);
    expect(creditsForTokens(1500, 0, rate)).toBe(2);
  });
});
