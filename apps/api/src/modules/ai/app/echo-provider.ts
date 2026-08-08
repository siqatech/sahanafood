import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  EMBEDDING_DIMENSIONS,
  type AiProvider,
  type ChatRequest,
  type ChatResponse,
} from '../domain/ai-provider.js';

/**
 * Proveedor LOCAL y determinista. El que corre en desarrollo y en CI.
 *
 * No llama a ninguna API: compone la respuesta con lo que ya está en el
 * contexto —las fuentes recuperadas y los resultados de las herramientas— y
 * genera embeddings a partir de un hash del texto.
 *
 * No es un mock de pruebas escondido en `src/`: es una decisión de
 * arquitectura. La suite dorada de T5.31 tiene que correr en cada PR, y no
 * puede depender de la red, de una clave de un tercero ni de que dos
 * ejecuciones del mismo prompt den lo mismo. Con un proveedor determinista, un
 * cambio que rompe la calidad se ve en el diff de la suite; con uno real, se
 * ve como un test que a veces falla.
 *
 * Los embeddings son **estables pero no semánticos**: sirven para probar que el
 * filtro por tenant funciona, que el índice se usa y que reindexar cambia los
 * vecinos. No sirven para medir calidad de recuperación, y eso queda anotado
 * aquí para que nadie mire un número de recall salido de este proveedor y se lo
 * crea.
 */
@Injectable()
export class EchoAiProvider implements AiProvider {
  readonly name = 'echo';

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const ultimoUsuario = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const contexto = request.messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
      .join(' ');

    // Se responde con lo que las herramientas devolvieron y NADA más. Es lo que
    // hace que este proveedor pase el validador de T5.24 por construcción: no
    // puede inventar un precio porque no sabe inventar nada.
    const texto = contexto
      ? `Según lo consultado: ${contexto}`.slice(0, 500)
      : `Te leo: "${ultimoUsuario?.content ?? ''}". ¿Te ayudo con la carta?`;

    return {
      text: texto,
      toolCalls: [],
      inputTokens: estimarTokens(request.messages.map((m) => m.content).join(' ')),
      outputTokens: estimarTokens(texto),
    };
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => embeddingDeterminista(t));
  }
}

/**
 * Embedding estable a partir del texto.
 *
 * Se siembra con un hash y se normaliza a longitud 1, que es lo que la
 * distancia coseno espera. Textos parecidos NO dan vectores parecidos: es un
 * generador reproducible, no un modelo.
 */
function embeddingDeterminista(text: string): number[] {
  const hash = createHash('sha256').update(text).digest();
  const v = new Array<number>(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    // Se recorre el hash en bucle y se centra en 0 para que el vector no quede
    // todo en el mismo octante, que haría que todo se pareciera a todo.
    v[i] = (hash[i % hash.length]! - 128) / 128;
  }
  const norma = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norma);
}

/** Aproximación de tokens. Suficiente para contar créditos en desarrollo. */
function estimarTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
