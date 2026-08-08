/**
 * Puerto del proveedor de IA (ADR-0011 §3, T5.22).
 *
 * «Proveedor vía adaptador, configurable por entorno; sin dependencia dura de
 * un vendor». La interfaz es deliberadamente pequeña: chat y embeddings. Todo
 * lo demás —herramientas, RAG, validación, presupuesto— es nuestro y no del
 * proveedor, que es lo que permite cambiarlo sin tocar el agente.
 *
 * Que sea un puerto también es lo que hace probable la degradación de T5.30 y
 * la suite dorada de T5.31: en las pruebas se inyecta un proveedor de mentira
 * que responde lo que haga falta, incluida una respuesta con un precio
 * inventado, sin gastar un céntimo ni depender de la red.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Nombre de la herramienta, cuando `role` es `tool`. */
  name?: string;
}

/** Herramienta que el modelo puede pedir que se ejecute. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema de los parámetros. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  /** Texto de la respuesta. Vacío si el modelo pidió herramientas. */
  text: string;
  toolCalls: readonly ToolCall[];
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** Dimensión de los embeddings. Fija en el esquema: cambiarla obliga a reindexar. */
export const EMBEDDING_DIMENSIONS = 1536;
