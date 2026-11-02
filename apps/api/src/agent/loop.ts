import type { LlmMessage, LlmProvider } from "../llm/provider";
import { executeTool, toToolDef, type Tool, type ToolContext } from "./tools/types";

export interface AgentRun {
  /** Texto final del modelo (sin pulir). */
  text: string;
  /** Mensajes nuevos generados en este turno (assistant + tool), para guardarlos. */
  newMessages: LlmMessage[];
  toolsUsed: string[];
}

export interface AgentOptions {
  llm: LlmProvider;
  system: string;
  history: LlmMessage[];
  tools: Tool[];
  ctx: ToolContext;
  maxSteps?: number;
}

/**
 * Bucle de tool calling: el modelo decide qué herramienta usar, se ejecuta,
 * ve el resultado y sigue hasta que responde con texto.
 */
export async function runAgent(opts: AgentOptions): Promise<AgentRun> {
  const maxSteps = opts.maxSteps ?? 6;
  const toolDefs = opts.tools.map(toToolDef);
  const messages: LlmMessage[] = [{ role: "system", content: opts.system }, ...opts.history];
  const newMessages: LlmMessage[] = [];
  const toolsUsed: string[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const isLast = step === maxSteps - 1;
    const res = await opts.llm.chat({ messages, tools: isLast ? undefined : toolDefs });

    if (!res.toolCalls.length) {
      const text = res.content?.trim() || "Hecho.";
      const msg: LlmMessage = { role: "assistant", content: text };
      newMessages.push(msg);
      return { text, newMessages, toolsUsed };
    }

    const assistant: LlmMessage = { role: "assistant", content: res.content ?? null, tool_calls: res.toolCalls };
    messages.push(assistant);
    newMessages.push(assistant);

    for (const call of res.toolCalls) {
      toolsUsed.push(call.function.name);
      const result = await executeTool(opts.tools, call.function.name, call.function.arguments, opts.ctx);
      const toolMsg: LlmMessage = { role: "tool", tool_call_id: call.id, content: JSON.stringify(result) };
      messages.push(toolMsg);
      newMessages.push(toolMsg);
    }
  }

  const text = "Me he liado con tantos pasos. ¿Me lo dices de otra forma?";
  newMessages.push({ role: "assistant", content: text });
  return { text, newMessages, toolsUsed };
}

/**
 * Recorta el historial para que empiece en un mensaje del usuario
 * (nunca con una respuesta de herramienta huérfana).
 */
export function trimHistory(history: LlmMessage[], max: number): LlmMessage[] {
  let slice = history.slice(-max);
  const firstUser = slice.findIndex((m) => m.role === "user");
  slice = firstUser === -1 ? [] : slice.slice(firstUser);
  return slice;
}
