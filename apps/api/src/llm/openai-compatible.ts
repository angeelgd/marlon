import { LlmError, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse, type ToolCall } from "./provider";

export interface OpenAiCompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
  tier: "free" | "paid";
  /**
   * Enviar "temperature". Los modelos Gemini 3.x la han dejado obsoleta, así que por
   * defecto no se envía; actívalo (LLM_SEND_TEMPERATURE=1) para proveedores que la usen.
   */
  sendTemperature?: boolean;
  /**
   * Modelos de reserva por si el principal está saturado (503) o sin cuota (429).
   * Se prueban en orden tras agotar los reintentos del anterior.
   */
  fallbackModels?: string[];
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface ApiChoice {
  message?: {
    content?: string | null;
    tool_calls?: {
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string | object };
      extra_content?: ToolCall["extra_content"];
    }[];
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly tier: "free" | "paid";

  constructor(private readonly cfg: OpenAiCompatibleConfig) {
    this.name = cfg.name;
    this.tier = cfg.tier;
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    const primary = req.vision && this.cfg.visionModel ? this.cfg.visionModel : this.cfg.model;
    const models = [primary, ...(this.cfg.fallbackModels ?? [])].filter((m, i, all) => m && all.indexOf(m) === i);
    let lastError: LlmError | null = null;
    for (const [i, model] of models.entries()) {
      try {
        return await this.chatWith(model, req, i < models.length - 1);
      } catch (err) {
        // Solo se cambia de modelo si el fallo es de saturación o cuota, no si la petición es mala.
        if (!(err instanceof LlmError) || !err.retryable) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new LlmError("No hay ningún modelo configurado.", null, false);
  }

  private async chatWith(model: string, req: LlmRequest, hasFallback: boolean): Promise<LlmResponse> {
    const isGemini = this.cfg.baseUrl.includes("generativelanguage.googleapis.com");
    const messages = isGemini ? withThoughtSignatures(req.messages) : req.messages;
    const body: Record<string, unknown> = { model, messages };
    if (this.cfg.sendTemperature && req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) body.tools = req.tools;
    if (req.json) body.response_format = { type: "json_object" };

    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const wait = this.cfg.sleepImpl ?? sleep;
    const maxRetries = this.cfg.maxRetries ?? 2;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await wait(500 * 2 ** attempt);
          continue;
        }
        throw new LlmError(`No se pudo contactar con el modelo: ${(err as Error).message}`, null, true);
      }

      if (res.ok) return parseResponse(await res.json());

      const retryable = res.status === 429 || res.status >= 500;
      // Saturado: con reserva disponible no se espera, se cambia de modelo directamente.
      const skipToFallback = res.status === 503 && hasFallback;
      if (retryable && !skipToFallback && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const text = (await res.text()).slice(0, 500);
      throw new LlmError(friendlyMessage(res.status, text), res.status, retryable);
    }
  }
}

/**
 * Valor que Google documenta para llamadas a herramientas sin firma (historial antiguo
 * o de otro modelo): desactiva la comprobación para esa llamada.
 */
export const SKIP_SIGNATURE = "skip_thought_signature_validator";

/**
 * Gemini 3 exige que cada paso con llamadas a herramientas lleve la firma que devolvió
 * (en la primera llamada del paso). Las que vienen del propio modelo ya la traen; a las
 * antiguas, guardadas antes de conservarla, se les pone el valor de omisión.
 */
export function withThoughtSignatures(messages: LlmMessage[]): LlmMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.tool_calls?.length) return m;
    if (m.tool_calls.some((t) => t.extra_content?.google?.thought_signature)) return m;
    const [first, ...rest] = m.tool_calls;
    return {
      ...m,
      tool_calls: [
        { ...first!, extra_content: { ...first!.extra_content, google: { ...first!.extra_content?.google, thought_signature: SKIP_SIGNATURE } } },
        ...rest,
      ],
    };
  });
}

function friendlyMessage(status: number, text: string): string {
  if (status === 429) return "Se ha alcanzado el límite de peticiones del modelo. Prueba de nuevo en un rato.";
  if (status === 503 || status === 502 || status === 504) {
    return "El modelo de IA está saturado ahora mismo (le pasa a Google en horas punta). Vuelve a intentarlo en uno o dos minutos.";
  }
  if (status >= 500) return `El modelo tuvo un fallo interno (${status}). Vuelve a intentarlo en un momento.`;
  return `El modelo respondió con un error ${status}: ${text}`;
}

export function parseResponse(json: unknown): LlmResponse {
  const data = json as { choices?: ApiChoice[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new LlmError("Respuesta del modelo sin contenido.", null, true);
  const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
    .filter((t) => t.function?.name)
    .map((t, i) => ({
      id: t.id || `call_${Date.now().toString(36)}_${i}`,
      type: "function",
      function: {
        name: t.function!.name!,
        arguments:
          typeof t.function!.arguments === "string" ? t.function!.arguments : JSON.stringify(t.function!.arguments ?? {}),
      },
      ...(t.extra_content ? { extra_content: t.extra_content } : {}),
    }));
  return {
    content: msg.content ?? null,
    toolCalls,
    usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
  };
}
