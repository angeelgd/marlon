/**
 * Interfaz común para cualquier modelo. Usa el formato de mensajes de
 * OpenAI Chat Completions, que hablan Gemini (endpoint compatible),
 * OpenRouter, Groq, Ollama, vLLM, etc.
 */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: ToolDef[];
  temperature?: number;
  /** Pide JSON como respuesta (para extracción estructurada). */
  json?: boolean;
  /** Usa el modelo de visión configurado si lo hay. */
  vision?: boolean;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface LlmProvider {
  readonly name: string;
  /** "free" si los datos pueden usarse para entrenar, "paid" si no. */
  readonly tier: "free" | "paid";
  chat(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** El envío necesita confirmación porque solo hay clave de capa gratuita. */
export class ConsentRequiredError extends Error {
  constructor(readonly reason: "financial" | "third_party") {
    super(
      reason === "financial"
        ? "Esto lleva datos económicos y solo hay clave de capa gratuita."
        : "La foto incluye datos de otras personas y solo hay clave de capa gratuita.",
    );
    this.name = "ConsentRequiredError";
  }
}
