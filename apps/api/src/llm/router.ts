import type { Env } from "../env";
import { MockProvider } from "./mock";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import { ConsentRequiredError, type LlmProvider } from "./provider";

/**
 * Sensibilidad de lo que se va a enviar al modelo:
 * - normal: conversación y calendario.
 * - third_party: datos de otras personas (p. ej. la foto del horario con compañeros).
 * - financial: tickets, sueldo, gastos.
 */
export type Sensitivity = "normal" | "third_party" | "financial";

export interface RouteOptions {
  sensitivity?: Sensitivity;
  /** El usuario aceptó usar la capa gratuita para este envío. */
  allowFreeTier?: boolean;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_MODEL = "gemini-2.5-flash";

function freeProvider(env: Env): LlmProvider | null {
  if (!env.LLM_API_KEY) return null;
  return new OpenAiCompatibleProvider({
    name: "default",
    baseUrl: env.LLM_BASE_URL || DEFAULT_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL || DEFAULT_MODEL,
    visionModel: env.LLM_VISION_MODEL,
    tier: "free",
  });
}

function paidProvider(env: Env): LlmProvider | null {
  if (!env.LLM_PAID_API_KEY) return null;
  return new OpenAiCompatibleProvider({
    name: "paid",
    baseUrl: env.LLM_PAID_BASE_URL || env.LLM_BASE_URL || DEFAULT_BASE_URL,
    apiKey: env.LLM_PAID_API_KEY,
    model: env.LLM_PAID_MODEL || env.LLM_MODEL || DEFAULT_MODEL,
    visionModel: env.LLM_VISION_MODEL,
    tier: "paid",
  });
}

/** Elige proveedor según la sensibilidad. Lanza ConsentRequiredError si hace falta permiso. */
export function getLlm(env: Env, opts: RouteOptions = {}): LlmProvider {
  if (env.LLM_PROVIDER === "mock") return new MockProvider();

  const sensitivity = opts.sensitivity ?? "normal";
  const paid = paidProvider(env);
  const free = freeProvider(env);

  if (sensitivity !== "normal") {
    if (paid) return paid;
    if (!free) throw new Error("No hay ninguna clave de modelo configurada (LLM_API_KEY).");
    if (!opts.allowFreeTier) throw new ConsentRequiredError(sensitivity);
    return free;
  }
  const p = free ?? paid;
  if (!p) throw new Error("No hay ninguna clave de modelo configurada (LLM_API_KEY).");
  return p;
}
