import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse, type ToolCall } from "./provider";

export interface OpenAiCompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string;
  tier: "free" | "paid";
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

interface ApiChoice {
  message?: {
    content?: string | null;
    tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string | object } }[];
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
    const body: Record<string, unknown> = {
      model: req.vision && this.cfg.visionModel ? this.cfg.visionModel : this.cfg.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.6,
    };
    if (req.tools?.length) body.tools = req.tools;
    if (req.json) body.response_format = { type: "json_object" };

    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const doFetch = this.cfg.fetchImpl ?? fetch;
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
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new LlmError(`No se pudo contactar con el modelo: ${(err as Error).message}`, null, true);
      }

      if (res.ok) return parseResponse(await res.json());

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 800 * 2 ** attempt);
        continue;
      }
      const text = (await res.text()).slice(0, 500);
      const msg =
        res.status === 429
          ? "Se ha alcanzado el límite de peticiones del modelo. Prueba de nuevo en un rato."
          : `El modelo respondió con un error ${res.status}: ${text}`;
      throw new LlmError(msg, res.status, retryable);
    }
  }
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
    }));
  return {
    content: msg.content ?? null,
    toolCalls,
    usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
  };
}
