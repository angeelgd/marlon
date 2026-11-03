import type { Env } from "../env";
import { getLlm } from "../llm/router";
import type { LlmProvider } from "../llm/provider";

/** Modelo para clasificar movimientos: solo con la clave de pago (los datos no se usan para entrenar). */
export function bankLlm(env: Env): LlmProvider | null {
  if (env.LLM_PROVIDER === "mock" || !env.LLM_PAID_API_KEY) return null;
  try {
    return getLlm(env, { sensitivity: "financial" });
  } catch {
    return null;
  }
}
