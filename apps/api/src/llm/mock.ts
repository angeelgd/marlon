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
      if (d.saved?.amount && d.saved?.category) return { content: `Apuntado: ${d.saved.amount} en ${d.saved.category.toLowerCase()}.`, toolCalls: [] };
      if (d.actual && d.if_full_schedule) {
        return { content: `Este mes llevas ${d.actual} brutos; con el horario completo serían ${d.if_full_schedule}. ${d.disclaimer}`, toolCalls: [] };
      }
      if (d.start && d.end && d.planned !== undefined) return { content: `Anotado: el ${d.date} trabajaste de ${d.start} a ${d.end}.`, toolCalls: [] };
      if (d.week_start && d.menu) return { content: `Menú listo para la semana del ${d.week_start}. La lista de la compra está en Más > Comida.`, toolCalls: [] };
      if (d.started?.title) return { content: `Empezamos «${d.started.title}». Cuando acabes un trayecto, dime por dónde vas.`, toolCalls: [] };
      if (d.started && d.phases !== undefined) return { content: `En marcha: ${d.started}. Total ${d.total}.`, toolCalls: [] };
      if (d.started && d.minutes !== undefined && !d.steps) return { content: `Empezamos: ${d.started}. Respira.`, toolCalls: [] };
      if (d.started && d.steps) return { content: `Vamos con ${d.started}. ${d.safety}`, toolCalls: [] };
      if (d.book && d.percent !== undefined) {
        const fin = d.estimated_finish ? ` Al ritmo de tus trayectos lo acabas el ${d.estimated_finish}.` : "";
        return { content: `Apuntado: vas por el ${d.percent} % de «${d.book}».${fin}`, toolCalls: [] };
      }
      if (d.saved && typeof d.saved === "string") return { content: `Me lo apunto: ${d.saved}`, toolCalls: [] };
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
    const spent = /gast\S*\s+(\d+(?:[.,]\d{1,2})?)\s*(?:€|euros?)?\s+en\s+(?:un |una )?(.+)/.exec(text);
    if (spent) {
      const what = spent[2]!.replace(/[.!?]+$/, "");
      const category = /caf[eé]/.test(what) ? "coffee" : /s[uú]per|compra/.test(what) ? "groceries" : "other";
      return call("log_expense", { amount: spent[1], category, merchant: what });
    }
    if (/cu[aá]nto\s+(he\s+)?ganad|sueldo|n[oó]mina/.test(text)) return call("calc_monthly_pay", {});
    if (/men[uú]/.test(text)) return call("build_menu_and_shopping_list", {});
    const out = /sal[ií]\s+a\s+las\s+(\d{1,2})[:.](\d{2})/.exec(text);
    if (out) return call("log_actual_shift", { end: `${out[1]!.padStart(2, "0")}:${out[2]}` });
    const timer = /(\d+)\s*(segundos?|s|minutos?|min)\s+de\s+(\w+),?\s*(\d+)\s*(segundos?|s|minutos?|min)?\s*de\s+descanso,?\s*(\d+)\s*(?:veces|rondas)/.exec(text);
    if (timer) {
      const isSec = (u?: string) => Boolean(u && u.startsWith("s"));
      const workSec = isSec(timer[2]) ? Number(timer[1]) : Number(timer[1]) * 60;
      const restSec = isSec(timer[5] ?? timer[2]) ? Number(timer[4]) : Number(timer[4]) * 60;
      return call("start_timer", {
        label: timer[3]![0]!.toUpperCase() + timer[3]!.slice(1),
        work_seconds: workSec,
        rest_seconds: restSec,
        rounds: Number(timer[6]),
      });
    }
    if (/medita/.test(text)) return call("start_meditation", { minutes: /10/.test(text) ? 10 : /3/.test(text) ? 3 : 5 });
    if (/estir/.test(text)) return call("start_stretching", { routine: /gimnasio|gym/.test(text) ? "post_gym" : "desk" });
    const reading = /voy por el (\d{1,3})\s*%/.exec(text);
    if (reading) return call("log_reading", { percent: Number(reading[1]) });
    const book = /empiezo (?:a leer )?[«"](.+)[»"]/.exec(lastUserText(req.messages));
    if (book) return call("start_book", { title: book[1] });
    const mem = /recuerda que (.+)/i.exec(lastUserText(req.messages));
    if (mem) return call("remember_fact", { content: mem[1]!.replace(/[.!]+$/, ""), category: "preference" });
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
