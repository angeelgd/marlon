import { describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider } from "../src/llm/openai-compatible";
import { ConsentRequiredError, LlmError } from "../src/llm/provider";
import { getLlm } from "../src/llm/router";
import { testEnv } from "./helpers";

function fakeFetch(responses: Response[]) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
    const r = responses.shift();
    if (!r) throw new Error("sin respuestas");
    return r;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("OpenAiCompatibleProvider", () => {
  it("envía modelo, herramientas y clave, y lee llamadas a herramientas", async () => {
    const { fn, calls } = fakeFetch([
      ok({
        choices: [{ message: { content: null, tool_calls: [{ id: "x1", type: "function", function: { name: "list_events", arguments: '{"a":1}' } }] } }],
      }),
    ]);
    const p = new OpenAiCompatibleProvider({ name: "t", baseUrl: "https://api.test/v1/", apiKey: "k", model: "m", tier: "free", fetchImpl: fn });
    const r = await p.chat({ messages: [{ role: "user", content: "hola" }], tools: [{ type: "function", function: { name: "list_events", description: "", parameters: {} } }] });
    expect(calls[0]!.url).toBe("https://api.test/v1/chat/completions");
    expect(calls[0]!.auth).toBe("Bearer k");
    expect((calls[0]!.body as { model: string }).model).toBe("m");
    expect(r.toolCalls[0]!.function).toEqual({ name: "list_events", arguments: '{"a":1}' });
  });

  it("usa el modelo de visión y response_format json cuando se pide", async () => {
    const { fn, calls } = fakeFetch([ok({ choices: [{ message: { content: "{}" } }] })]);
    const p = new OpenAiCompatibleProvider({ name: "t", baseUrl: "https://api.test", apiKey: "k", model: "m", visionModel: "v", tier: "free", fetchImpl: fn });
    await p.chat({ messages: [], vision: true, json: true });
    expect(calls[0]!.body).toMatchObject({ model: "v", response_format: { type: "json_object" } });
  });

  it("reintenta tras un 429 y acaba dando un error claro", async () => {
    const { fn, calls } = fakeFetch([
      new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      ok({ choices: [{ message: { content: "hola" } }] }),
    ]);
    const p = new OpenAiCompatibleProvider({ name: "t", baseUrl: "https://a", apiKey: "k", model: "m", tier: "free", fetchImpl: fn, maxRetries: 1 });
    expect((await p.chat({ messages: [] })).content).toBe("hola");
    expect(calls).toHaveLength(2);

    const f2 = fakeFetch([new Response("x", { status: 429 }), new Response("x", { status: 429 })]);
    const p2 = new OpenAiCompatibleProvider({ name: "t", baseUrl: "https://a", apiKey: "k", model: "m", tier: "free", fetchImpl: f2.fn, maxRetries: 1 });
    await expect(p2.chat({ messages: [] })).rejects.toBeInstanceOf(LlmError);
  });
});

describe("router", () => {
  it("datos sensibles van por la clave de pago si existe", () => {
    const env = testEnv({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "free", LLM_PAID_API_KEY: "paid" });
    expect(getLlm(env).tier).toBe("free");
    expect(getLlm(env, { sensitivity: "financial" }).tier).toBe("paid");
  });

  it("sin clave de pago, los datos económicos piden permiso", () => {
    const env = testEnv({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "free" });
    expect(() => getLlm(env, { sensitivity: "financial" })).toThrow(ConsentRequiredError);
    expect(getLlm(env, { sensitivity: "financial", allowFreeTier: true }).tier).toBe("free");
  });

  it("sin ninguna clave da un error explicativo", () => {
    expect(() => getLlm(testEnv({ LLM_PROVIDER: "openai-compatible" }))).toThrow("LLM_API_KEY");
  });
});
