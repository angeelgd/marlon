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
/**
 * Alias que Google mantiene apuntando al Flash más reciente (avisa dos semanas antes
 * de cambiarlo), para no depender de un modelo con fecha de retirada.
 * Para fijar uno concreto, usa LLM_MODEL.
 */
export const DEFAULT_MODEL = "gemini-flash-latest";
/** Reserva por defecto con Gemini: Flash-Lite tiene otra cuota y suele estar menos saturado. */
export const DEFAULT_FALLBACK_MODELS = ["gemini-flash-lite-latest"];

/**
 * LLM_FALLBACK_MODELS: lista separada por comas. "none" la desactiva.
 * Sin valor, con el endpoint de Gemini se usa Flash-Lite; con otro proveedor, ninguna.
 */
export function fallbackModels(env: Env, baseUrl: string): string[] {
  const raw = env.LLM_FALLBACK_MODELS?.trim();
  if (raw === "none") return [];
  if (raw) return raw.split(",").map((m) => m.trim()).filter(Boolean);
  return baseUrl.includes("generativelanguage.googleapis.com") ? DEFAULT_FALLBACK_MODELS : [];
}

function freeProvider(env: Env): LlmProvider | null {
  if (!env.LLM_API_KEY) return null;
  const baseUrl = env.LLM_BASE_URL || DEFAULT_BASE_URL;
  return new OpenAiCompatibleProvider({
    name: "default",
    baseUrl,
    fallbackModels: fallbackModels(env, baseUrl),
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL || DEFAULT_MODEL,
    visionModel: env.LLM_VISION_MODEL,
    tier: "free",
    sendTemperature: env.LLM_SEND_TEMPERATURE === "1",
  });
}

function paidProvider(env: Env): LlmProvider | null {
  if (!env.LLM_PAID_API_KEY) return null;
  const baseUrl = env.LLM_PAID_BASE_URL || env.LLM_BASE_URL || DEFAULT_BASE_URL;
  return new OpenAiCompatibleProvider({
    name: "paid",
    baseUrl,
    fallbackModels: fallbackModels(env, baseUrl),
    apiKey: env.LLM_PAID_API_KEY,
    model: env.LLM_PAID_MODEL || env.LLM_MODEL || DEFAULT_MODEL,
    visionModel: env.LLM_VISION_MODEL,
    tier: "paid",
    sendTemperature: env.LLM_SEND_TEMPERATURE === "1",
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
