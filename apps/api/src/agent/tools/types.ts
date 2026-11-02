import type { SchedulePreview, Settings } from "@marlon/shared";
import { z } from "zod";
import type { CalendarService } from "../../calendar/service";
import type { Env } from "../../env";
import type { ToolDef } from "../../llm/provider";
import type { RouteOptions } from "../../llm/router";
import type { LlmProvider } from "../../llm/provider";

export interface ToolContext {
  env: Env;
  db: D1Database;
  settings: Settings;
  calendar: CalendarService;
  /** IDs de las imágenes adjuntas en este turno (por índice). */
  imageIds: string[];
  now: number;
  llm: (opts?: RouteOptions) => LlmProvider;
  /** fetch para APIs externas (se sustituye en los tests). */
  fetchImpl?: typeof fetch;
  /** Salidas hacia la interfaz que pueden rellenar las herramientas. */
  out: {
    quickReplies: string[];
    preview?: SchedulePreview;
    notice?: string;
  };
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string; hint?: string };

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

/** Error con una pista para que el modelo pueda corregirse. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Gemini (y otros) no aceptan algunas claves de JSON Schema. */
function cleanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema" || k === "additionalProperties" || k === "$id") continue;
      out[k] = cleanSchema(v);
    }
    return out;
  }
  return node;
}

export function toToolDef(tool: Tool): ToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: cleanSchema(z.toJSONSchema(tool.schema, { io: "input" })) as Record<string, unknown>,
    },
  };
}

export async function executeTool(tools: Tool[], name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `La herramienta "${name}" no existe.` };
  let json: unknown;
  try {
    json = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { ok: false, error: "Los argumentos no son JSON válido.", hint: "Envía un objeto JSON." };
  }
  const parsed = tool.schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Argumentos no válidos.",
      hint: z.prettifyError(parsed.error),
    };
  }
  try {
    return { ok: true, data: await tool.run(parsed.data, ctx) };
  } catch (err) {
    const e = err as Error & { hint?: string };
    return { ok: false, error: e.message || String(err), hint: e.hint };
  }
}
