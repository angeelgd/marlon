import { DEFAULT_SETTINGS } from "@marlon/shared";
import type { ToolContext } from "../src/agent/tools/types";
import { LocalBackend } from "../src/calendar/backend";
import { CalendarService } from "../src/calendar/service";
import type { Env } from "../src/env";
import type { LlmProvider, LlmRequest, LlmResponse } from "../src/llm/provider";
import { createTestDb } from "./d1-shim";

export const TZ = "Europe/Helsinki";

export function testEnv(extra: Partial<Env> = {}): Env {
  return { DB: createTestDb(), LLM_PROVIDER: "mock", SESSION_SECRET: "x".repeat(40), SETUP_TOKEN: "setup-123", ...extra };
}

export function testCtx(env: Env, now = Date.parse("2026-11-01T10:00:00Z"), llm?: LlmProvider): ToolContext {
  const calendar = new CalendarService(env.DB, new LocalBackend(), TZ, "primary");
  return {
    env,
    db: env.DB,
    settings: { ...DEFAULT_SETTINGS },
    calendar,
    imageIds: [],
    now,
    llm: () => llm ?? scripted([]),
    out: { quickReplies: [] },
  };
}

/** Proveedor con respuestas guionizadas; cada paso recibe la petición. */
export function scripted(steps: ((req: LlmRequest) => LlmResponse)[]): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name: "scripted",
    tier: "paid",
    calls,
    async chat(req) {
      calls.push(structuredClone(req));
      const step = steps[calls.length - 1];
      if (!step) throw new Error("El guion no tiene más pasos");
      return step(req);
    },
  };
}

export const toolCall = (name: string, args: unknown, id = `c_${name}`): LlmResponse => ({
  content: null,
  toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

export const say = (content: string): LlmResponse => ({ content, toolCalls: [] });
