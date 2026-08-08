import { describe, it, expect } from 'vitest';
import {
  messagesPerOrder,
  conversionBps,
  MESSAGES_PER_ORDER_TARGET,
} from './agent-kpi.js';
import { unansweredTopics } from './unanswered-topics.js';

describe('KPI del agente (spec 19 §7, T5.32)', () => {
  it('mide mensajes por pedido y compara con el objetivo', () => {
    const r = messagesPerOrder({ messages: 24, orders: 4 });
    expect(r.value).toBe(6);
    expect(r.target).toBe(MESSAGES_PER_ORDER_TARGET);
    expect(r.meetsTarget).toBe(true);
  });

  it('el borde exacto CUMPLE y un pelo por encima NO', () => {
    expect(messagesPerOrder({ messages: 8, orders: 1 }).meetsTarget).toBe(true);
    // 8,004 se muestra como 8,00 pero NO cumple: si se comparara el valor ya
    // redondeado, un objetivo incumplido se pintaría en verde.
    const apenas = messagesPerOrder({ messages: 8004, orders: 1000 });
    expect(apenas.value).toBe(8);
    expect(apenas.meetsTarget).toBe(false);
  });

  it('sin pedidos el KPI no se cumple NI se incumple', () => {
    // Un `<=` sobre cero daría `true` y pintaría el panel en verde el día que
    // el agente no vendió nada, que es justo el día que hay que mirarlo.
    const r = messagesPerOrder({ messages: 120, orders: 0 });
    expect(r.value).toBeNull();
    expect(r.meetsTarget).toBeNull();
  });

  it('la conversión sale en puntos básicos', () => {
    expect(conversionBps({ conversations: 200, converted: 50 })).toBe(2500);
    expect(conversionBps({ conversations: 3, converted: 1 })).toBe(3333);
    // Sin conversaciones no se divide entre cero.
    expect(conversionBps({ conversations: 0, converted: 0 })).toBe(0);
  });
});

describe('Temas preguntados sin fuente (spec 19 §6, T5.32)', () => {
  it('ordena por número de MENSAJES, no de apariciones', () => {
    const topics = unansweredTopics([
      'quiero ceviche ceviche ceviche',
      '¿tienen ceviche?',
      '¿hacen tequeños?',
      '¿tienen tequeños hoy?',
      '¿los tequeños son picantes?',
    ]);
    // «ceviche» aparece 4 veces pero en 2 mensajes; «tequeños», en 3. Contar
    // apariciones dejaría que un cliente repetitivo marcara la agenda del dueño.
    expect(topics[0]!.term).toBe('tequenos');
    expect(topics[0]!.messages).toBe(3);
    expect(topics[1]!.term).toBe('ceviche');
    expect(topics[1]!.messages).toBe(2);
  });

  it('ignora las palabras vacías y las muy cortas', () => {
    const topics = unansweredTopics([
      'hola buenas quiero eso por favor',
      'hola buenas gracias',
      'hola que tal',
    ]);
    // Sin la lista de vacías, «hola» sería el tema más preguntado de todos los
    // tenants, siempre.
    expect(topics).toEqual([]);
  });

  it('normaliza tildes: la misma palabra escrita de dos formas es UNA', () => {
    const topics = unansweredTopics([
      '¿tienen acompañamiento?',
      'quiero acompanamiento',
    ]);
    expect(topics).toHaveLength(1);
    expect(topics[0]!.messages).toBe(2);
  });

  it('devuelve ejemplos literales para poder verificar la cifra', () => {
    // El dueño tiene que poder decir «enséñame esas conversaciones». Un número
    // sin ejemplos no se discute: se cree o no se cree.
    const topics = unansweredTopics([
      '¿tienen delivery a Barranco?',
      '¿llegan a Barranco?',
    ]);
    expect(topics[0]!.examples).toContain('¿llegan a Barranco?');
  });

  it('un término que aparece una sola vez NO es un tema', () => {
    // Con el umbral en 1, la lista sería el vocabulario entero del día y no
    // señalaría nada.
    expect(unansweredTopics(['¿tienen anticuchos?'])).toEqual([]);
    expect(
      unansweredTopics(['¿tienen anticuchos?'], { minMessages: 1 }),
    ).toHaveLength(1);
  });

  it('el orden es estable ante empates', () => {
    const textos = ['ceviche tequenos', 'tequenos ceviche'];
    expect(unansweredTopics(textos).map((t) => t.term)).toEqual([
      'ceviche',
      'tequenos',
    ]);
  });
});
