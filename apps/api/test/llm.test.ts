import { describe, expect, it, vi } from "vitest";
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

describe("modelos de reserva", () => {
  const noSleep = async () => {};
  it("si el principal está saturado (503), pasa al de reserva", async () => {
    const busy = () => new Response('{"error":{"code":503,"status":"UNAVAILABLE"}}', { status: 503 });
    const { fn, calls } = fakeFetch([busy(), ok({ choices: [{ message: { content: "hola" } }] })]);
    const p = new OpenAiCompatibleProvider({
      name: "t", baseUrl: "https://a", apiKey: "k", model: "m", fallbackModels: ["lite"], tier: "free",
      fetchImpl: fn, maxRetries: 1, sleepImpl: noSleep,
    });
    expect((await p.chat({ messages: [] })).content).toBe("hola");
    expect(calls.map((c) => (c.body as { model: string }).model)).toEqual(["m", "lite"]);
  });

  it("da un mensaje claro si todos están saturados y no cambia de modelo ante un 400", async () => {
    const busy = () => new Response("x", { status: 503 });
    const f = fakeFetch([busy(), busy()]);
    const p = new OpenAiCompatibleProvider({
      name: "t", baseUrl: "https://a", apiKey: "k", model: "m", fallbackModels: ["lite"], tier: "free",
      fetchImpl: f.fn, maxRetries: 0, sleepImpl: noSleep,
    });
    await expect(p.chat({ messages: [] })).rejects.toThrow(/saturado/);

    const bad = fakeFetch([new Response("bad", { status: 400 })]);
    const p2 = new OpenAiCompatibleProvider({
      name: "t", baseUrl: "https://a", apiKey: "k", model: "m", fallbackModels: ["lite"], tier: "free",
      fetchImpl: bad.fn, maxRetries: 0, sleepImpl: noSleep,
    });
    await expect(p2.chat({ messages: [] })).rejects.toThrow(/400/);
    expect(bad.calls).toHaveLength(1);
  });

  it("con Gemini usa Flash-Lite de reserva salvo que se configure otra cosa", async () => {
    const { fallbackModels } = await import("../src/llm/router");
    const gem = "https://generativelanguage.googleapis.com/v1beta/openai";
    expect(fallbackModels(testEnv({}), gem)).toEqual(["gemini-flash-lite-latest"]);
    expect(fallbackModels(testEnv({ LLM_FALLBACK_MODELS: "a, b" }), gem)).toEqual(["a", "b"]);
    expect(fallbackModels(testEnv({ LLM_FALLBACK_MODELS: "none" }), gem)).toEqual([]);
    expect(fallbackModels(testEnv({}), "https://openrouter.ai/api/v1")).toEqual([]);
  });
});

describe("temperatura y modelo por defecto", () => {
  it("no envía temperature salvo que se active (Gemini 3.x la ha dejado obsoleta)", async () => {
    const mk = (sendTemperature: boolean) => {
      const f = fakeFetch([ok({ choices: [{ message: { content: "x" } }] })]);
      return { f, p: new OpenAiCompatibleProvider({ name: "t", baseUrl: "https://a", apiKey: "k", model: "m", tier: "free", fetchImpl: f.fn, sendTemperature }) };
    };
    const off = mk(false);
    await off.p.chat({ messages: [], temperature: 0 });
    expect(off.f.calls[0]!.body).not.toHaveProperty("temperature");
    const on = mk(true);
    await on.p.chat({ messages: [], temperature: 0 });
    expect(on.f.calls[0]!.body).toMatchObject({ temperature: 0 });
  });

  it("por defecto usa el alias que no caduca", async () => {
    const f = fakeFetch([ok({ choices: [{ message: { content: "x" } }] })]);
    const env = testEnv({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "k" });
    vi.stubGlobal("fetch", f.fn);
    await getLlm(env).chat({ messages: [] });
    vi.unstubAllGlobals();
    expect((f.calls[0]!.body as { model: string }).model).toBe("gemini-flash-latest");
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
