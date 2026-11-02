import { DEFAULT_SETTINGS } from "@marlon/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "../src/agent/chat";
import { addExpense, expenseSummary, listExpenses, parseAmount, setBudgetItem } from "../src/money/expenses";
import { consentAnswer, looksFinancial } from "../src/money/sensitivity";
import { testEnv } from "./helpers";

describe("detección de datos económicos", () => {
  it("detecta importes y palabras de dinero", () => {
    for (const t of [
      "me acabo de gastar 4,50 en un café",
      "pagué 12€ de luz",
      "¿cuánto he ganado este mes?",
      "este es el ticket del súper",
      "mi sueldo neto es 1400",
      "I spent 20 euros",
    ]) {
      expect(looksFinancial(t), t).toBe(true);
    }
    for (const t of ["buenos días", "recuérdame contestar a Mateo", "mueve el gimnasio al jueves", "salgo a las 15.45"]) {
      expect(looksFinancial(t), t).toBe(false);
    }
  });

  it("reconoce las respuestas de permiso", () => {
    expect(consentAnswer("Enviar esta vez")).toBe("once");
    expect(consentAnswer("enviar siempre")).toBe("always");
    expect(consentAnswer("No enviar.")).toBe("no");
    expect(consentAnswer("vale")).toBeNull();
  });

  it("lee importes en varios formatos", () => {
    expect(parseAmount("4,50")).toBe(450);
    expect(parseAmount("4.50 €")).toBe(450);
    expect(parseAmount("1.234,56")).toBe(123456);
    expect(parseAmount("1,234.56")).toBe(123456);
    expect(parseAmount(12)).toBe(1200);
    expect(parseAmount("doce")).toBeNull();
  });
});

/** Proveedor compatible con OpenAI falso: guarda las peticiones y responde con un guion. */
function fakeOpenAi(script: ((body: { messages: { role: string; content: unknown }[] }) => unknown)[]) {
  const calls: { url: string; auth: string; body: { messages: { role: string; content: unknown }[]; model: string } }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization") ?? "", body });
    const step = script[calls.length - 1];
    if (!step) throw new Error("sin guion");
    return new Response(JSON.stringify({ choices: [{ message: step(body) }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const tool = (name: string, args: unknown) => ({ content: null, tool_calls: [{ id: `t_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const text = (content: string) => ({ content });

describe("permiso para la capa gratuita", () => {
  afterEach(() => vi.unstubAllGlobals());
  const NOW = Date.parse("2026-11-02T10:00:00Z");
  const freeEnv = () => testEnv({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "free-key", LLM_BASE_URL: "https://free.example/v1" });

  it("pregunta antes de enviar, y con 'Enviar esta vez' lo procesa y lo marca como sensible", async () => {
    const env = freeEnv();
    const ai = fakeOpenAi([
      () => tool("log_expense", { amount: 4.5, category: "coffee", merchant: "café" }),
      () => text("Apuntado, 4,50 € en cafés."),
      (body) => {
        // Turno siguiente, sin datos económicos: el historial no lleva el gasto.
        expect(JSON.stringify(body.messages)).not.toContain("4,50");
        return text("¡Hola!");
      },
    ]);
    vi.stubGlobal("fetch", ai.fn);

    const q = await handleChat(env, { text: "me acabo de gastar 4,50 en un café", images: [] }, NOW);
    expect(q.message.quickReplies).toEqual(["Enviar esta vez", "Enviar siempre", "No enviar"]);
    expect(ai.calls).toHaveLength(0);

    const r = await handleChat(env, { text: "Enviar esta vez", images: [] }, NOW + 5000);
    expect(r.message.text).toBe("Apuntado, 4,50 € en cafés.");
    expect(ai.calls[0]!.auth).toBe("Bearer free-key");
    expect(JSON.stringify(ai.calls[0]!.body.messages)).toContain("4,50 en un café");
    const exp = await listExpenses(env.DB, "2026-11-01", "2026-11-30");
    expect(exp.map((e) => [e.amountCents, e.category])).toEqual([[450, "coffee"]]);

    await handleChat(env, { text: "hola", images: [] }, NOW + 10000);
    const sens = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE sensitive = 1`).first<{ n: number }>();
    expect(sens!.n).toBeGreaterThan(0);
  });

  it("'No enviar' no manda nada", async () => {
    const env = freeEnv();
    const ai = fakeOpenAi([]);
    vi.stubGlobal("fetch", ai.fn);
    await handleChat(env, { text: "pagué 30 euros de luz", images: [] }, NOW);
    const r = await handleChat(env, { text: "No enviar", images: [] }, NOW + 1000);
    expect(r.message.text).toContain("no lo envío");
    expect(ai.calls).toHaveLength(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM pending_consents`).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("'Enviar siempre' lo recuerda", async () => {
    const env = freeEnv();
    const ai = fakeOpenAi([() => text("ok"), () => text("ok2")]);
    vi.stubGlobal("fetch", ai.fn);
    await handleChat(env, { text: "mi sueldo neto es 1400", images: [] }, NOW);
    await handleChat(env, { text: "Enviar siempre", images: [] }, NOW + 1000);
    const r = await handleChat(env, { text: "pagué 12€ de luz", images: [] }, NOW + 2000);
    expect(r.message.text).toBe("ok2");
    expect(ai.calls).toHaveLength(2);
  });

  it("con clave de pago, los datos económicos van por ella sin preguntar", async () => {
    const env = testEnv({
      LLM_PROVIDER: "openai-compatible",
      LLM_API_KEY: "free-key",
      LLM_PAID_API_KEY: "paid-key",
      LLM_BASE_URL: "https://free.example/v1",
      LLM_PAID_BASE_URL: "https://paid.example/v1",
    });
    const ai = fakeOpenAi([() => text("Llevas poco este mes."), () => text("Hola")]);
    vi.stubGlobal("fetch", ai.fn);
    await handleChat(env, { text: "¿cuánto he gastado este mes?", images: [] }, NOW);
    expect(ai.calls[0]!.url).toBe("https://paid.example/v1/chat/completions");
    expect(ai.calls[0]!.auth).toBe("Bearer paid-key");
    await handleChat(env, { text: "buenos días", images: [] }, NOW + 1000);
    expect(ai.calls[1]!.auth).toBe("Bearer free-key");
    // Por la capa gratuita no viaja el turno anterior con dinero.
    expect(JSON.stringify(ai.calls[1]!.body.messages)).not.toContain("gastado");
  });

  it("si una herramienta de dinero se usa sin permiso, se pregunta igualmente", async () => {
    const env = freeEnv();
    const ai = fakeOpenAi([() => tool("expense_summary", {}), () => text("Necesito permiso.")]);
    vi.stubGlobal("fetch", ai.fn);
    const r = await handleChat(env, { text: "¿qué tal voy este mes?", images: [] }, NOW);
    expect(r.message.quickReplies).toEqual(["Enviar esta vez", "Enviar siempre", "No enviar"]);
    // La herramienta se negó: ningún dato económico llegó al modelo.
    expect(JSON.stringify(ai.calls[1]?.body.messages ?? [])).toContain("needs_financial_consent");
  });
});

describe("resumen de gastos", () => {
  it("50/30/20, comparación de cafés y proyección", async () => {
    const env = testEnv();
    await setBudgetItem(env.DB, { kind: "income", name: "Sueldo neto", amountCents: 140000 });
    await setBudgetItem(env.DB, { kind: "fixed", name: "Alquiler", amountCents: 55000, bucket: "needs" });
    await setBudgetItem(env.DB, { kind: "fixed", name: "Spotify", amountCents: 1199, bucket: "wants" });
    for (let d = 1; d <= 10; d++) {
      await addExpense(env.DB, { date: `2026-11-${String(d).padStart(2, "0")}`, amountCents: 450, category: "coffee", source: "text" });
    }
    await addExpense(env.DB, { date: "2026-11-05", amountCents: 6000, category: "groceries", source: "receipt" });
    await addExpense(env.DB, { date: "2026-10-05", amountCents: 900, category: "coffee", source: "text" });

    const s = await expenseSummary(env.DB, "2026-11", DEFAULT_SETTINGS, { today: "2026-11-10" });
    expect(s.incomeSource).toBe("budget");
    expect(s.variableCents).toBe(10500);
    expect(s.rule503020.needsCents).toBe(55000 + 6000);
    expect(s.rule503020.wantsCents).toBe(1199 + 4500);
    expect(s.rule503020.savingsTargetCents).toBe(28000);
    // 10 días: 105 € de gasto variable → 315 € al mes.
    expect(s.rule503020.projectedLeftCents).toBe(140000 - 56199 - 31500);
    const plain = (t: string) => t.replace(/\u00a0/g, " ");
    expect(plain(s.comparisons[0]!)).toBe(
      "Este mes llevas 45,00 € en 10 cafés. Con un termo y un paquete de café habrías ahorrado unos 16,50 €, ya contando el termo.",
    );
    expect(s.alerts.some((a) => plain(a).includes("cafés llevas 45,00 €"))).toBe(true);
    expect(s.disclaimer).toContain("No soy asesor financiero");
  });

  it("sin sueldo en los ajustes usa la estimación de las horas y lo dice", async () => {
    const env = testEnv();
    const s = await expenseSummary(env.DB, "2026-11", DEFAULT_SETTINGS, { today: "2026-11-10", payEstimateCents: 90000 });
    expect(s.incomeSource).toBe("pay_estimate");
    expect(s.incomeCents).toBe(90000);
  });

  it("no acepta importes absurdos", async () => {
    const env = testEnv();
    await expect(addExpense(env.DB, { date: "2026-11-01", amountCents: 0, category: "other", source: "text" })).rejects.toThrow();
  });
});
