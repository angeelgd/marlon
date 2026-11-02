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

export const MOCK_TRANSCRIPT = "Recuérdame contestar a Mateo";

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
    // Transcripción: el audio de prueba siempre "dice" lo mismo.
    const first = req.messages[0];
    if (first?.role === "user" && Array.isArray(first.content) && first.content.some((p) => p.type === "input_audio")) {
      return { content: MOCK_TRANSCRIPT, toolCalls: [] };
    }

    const last = req.messages[req.messages.length - 1];
    if (last?.role === "tool") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: { ok?: boolean; error?: string; data?: any } = {};
      try {
        parsed = JSON.parse(last.content);
      } catch {
        /* nada */
      }
      if (parsed.ok === false) return { content: `No he podido hacerlo: ${parsed.error}`, toolCalls: [] };
      const d = parsed.data ?? {};
      if (Array.isArray(d.slots)) {
        const list = d.slots.map((s: { start: string; end: string }) => `${s.start.slice(11)} a ${s.end.slice(11)}`).join(", ");
        return { content: d.slots.length ? `Tienes libre: ${list}.` : "Hoy no te queda ningún hueco libre.", toolCalls: [] };
      }
      if (d.day_load) {
        const leave = d.leave_for_next ? ` Para "${d.leave_for_next.title}" sal a las ${d.leave_for_next.leaveAt.slice(11)}.` : "";
        return {
          content: `Buenos días Ángel. Son las ${d.now.slice(11)} y hoy tienes un día ${d.day_load.level}.${leave} Vamos a por ello. ¿Alguna duda?`,
          toolCalls: [],
        };
      }
      if (d.tomorrow) {
        return {
          content: `Mañana es ${d.tomorrow_weekday}. Acuéstate a las ${d.sleep.bed_tonight.slice(11)} y levántate a las ${d.sleep.wake_tomorrow.slice(11)}. Descansa.`,
          toolCalls: [],
        };
      }
      if (d.saved?.kind) return { content: `Apuntado: ${d.saved.title}. Te lo iré recordando.`, toolCalls: [] };
      if (d.closed) return { content: `¡Hecho! Quito "${d.closed.title}" de la lista.`, toolCalls: [] };
      if (Array.isArray(d.sessions)) {
        return {
          content: d.sessions.length
            ? `Gimnasio esta semana: ${d.sessions.join("; ")}.`
            : "Esta semana no cabe ninguna sesión de gimnasio sin recortar sueño.",
          toolCalls: [],
        };
      }
      return { content: parsed.data?.summary ?? "Hecho, ya lo tienes en el calendario.", toolCalls: [] };
    }

    const text = lastUserText(req.messages).toLowerCase();
    if (text.includes("[imagen 0]")) return call("parse_schedule_photo", { image_index: 0 });
    if (text.includes("hueco")) {
      return call("find_free_slots", { from_date: today(), to_date: today(), duration_minutes: 60 });
    }
    if (text.includes("buenos días") || text.includes("buenos dias") || text.includes("good morning")) {
      return call("get_daily_briefing", {});
    }
    if (text.includes("buenas noches") || text.includes("good night")) return call("get_evening_review", {});
    if (text.includes("gimnasio") || text.includes("gym")) return call("plan_gym_week", {});
    const remind = /recu[eé]rdame\s+(.+)/i.exec(lastUserText(req.messages));
    if (remind) {
      const title = remind[1]!.replace(/[.!?]+$/, "");
      return call("add_pending", { kind: "reminder", title: title[0]!.toUpperCase() + title.slice(1) });
    }
    if (/\bya\b.*\b(le |lo )?(contest|hice|hecho|está|esta)/.test(text)) {
      return call("close_pending", { query: text.replace(/\bya\b/, "") });
    }
    return { content: "Estoy en modo de prueba, pero te leo. ¿Qué organizamos?", toolCalls: [] };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
