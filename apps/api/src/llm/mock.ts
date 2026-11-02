import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from "./provider";

/**
 * Proveedor de prueba para desarrollo local y tests de extremo a extremo.
 * No llama a ninguna API: responde con reglas sencillas y deterministas.
 * Se activa con LLM_PROVIDER=mock.
 */

export const MOCK_SCHEDULE_ROWS = {
  column_found: true,
  column_name: "Angel",
  rows: [
    { date: "Nov-02", weekday: "Mon", start: "15.45", end: "22.00", hours: "6,25" },
    { date: "Nov-03", weekday: "Tue", start: "", end: "", hours: "0,00" },
    { date: "Nov-04", weekday: "Wed", start: "16.00", end: "22.00", hours: "6,00" },
    { date: "Nov-05", weekday: "Thu", start: "15.45", end: "22.00", hours: "6,25" },
    { date: "Nov-06", weekday: "Fri", start: "17.00", end: "23.30", hours: "6,50" },
    { date: "Nov-07", weekday: "Sat", start: "", end: "", hours: "0,00" },
    { date: "Nov-08", weekday: "Sun", start: "12.45", end: "20.00", hours: "7,25" },
  ],
};

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      return typeof m.content === "string"
        ? m.content
        : m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
    }
  }
  return "";
}

let counter = 0;
const call = (name: string, args: object): LlmResponse => ({
  content: null,
  toolCalls: [{ id: `mock_${++counter}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly tier = "paid" as const;

  async chat(req: LlmRequest): Promise<LlmResponse> {
    if (req.json) return { content: JSON.stringify(MOCK_SCHEDULE_ROWS), toolCalls: [] };

    const last = req.messages[req.messages.length - 1];
    if (last?.role === "tool") {
      let parsed: { ok?: boolean; error?: string; data?: { summary?: string } } = {};
      try {
        parsed = JSON.parse(last.content);
      } catch {
        /* nada */
      }
      if (parsed.ok === false) return { content: `No he podido hacerlo: ${parsed.error}`, toolCalls: [] };
      return { content: parsed.data?.summary ?? "Hecho, ya lo tienes en el calendario.", toolCalls: [] };
    }

    const text = lastUserText(req.messages).toLowerCase();
    if (text.includes("[imagen 0]")) return call("parse_schedule_photo", { image_index: 0 });
    if (text.includes("hueco")) {
      return call("find_free_slots", { from_date: today(), to_date: today(), duration_minutes: 60 });
    }
    if (text.includes("good morning") || text.includes("hello")) {
      return { content: "Good morning Ángel, I'm in test mode, but I'm here.", toolCalls: [] };
    }
    return { content: "Estoy en modo de prueba, pero te leo. ¿Qué organizamos?", toolCalls: [] };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
