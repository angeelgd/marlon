import { addDays, localToMs } from "../lib/time";
import type { PendingRow } from "./store";

/**
 * Insistencia gradual con los pendientes del día, "con naturalidad": cada
 * aviso llega un poco antes que el anterior y con un tono algo distinto,
 * hasta que el usuario dice que ya está. Nunca en mitad de un compromiso,
 * antes de levantarse ni después de la hora de acostarse.
 */

/** Minutos entre un aviso y el siguiente (después del primero). */
export const NUDGE_GAPS_MIN = [180, 120, 90, 60, 60];
/** Avisos como mucho en el día del vencimiento, y en los días siguientes si sigue abierto. */
export const MAX_NUDGES_TODAY = NUDGE_GAPS_MIN.length + 1;
export const MAX_NUDGES_OVERDUE = 2;

export interface DayFrame {
  date: string; // hoy, local
  tz: string;
  wake: number;
  /** Hora límite: acostarse menos el rato para relajarse. */
  quietFrom: number;
  /** Compromisos de hoy (no se avisa en medio). */
  busy: { start: number; end: number }[];
}

export interface NudgeDecision {
  at: number;
  /** Número de aviso de hoy (0 = primero). */
  index: number;
  title: string;
  body: string;
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

export function nudgeText(title: string, index: number, overdue: boolean): { title: string; body: string } {
  const t = title.trim().replace(/[.!]+$/, "");
  const lt = lowerFirst(t);
  if (overdue) {
    return index === 0
      ? { title: "Sigue pendiente", body: `Ayer quedó sin hacer: ${lt}. ¿Le buscamos un hueco hoy?` }
      : { title: "Pendiente", body: `Te recuerdo que sigue abierto: ${lt}. Si ya está, dímelo y lo cierro.` };
  }
  const variants = [
    { title: "Recuerda", body: `${t}.` },
    { title: "¿Qué tal?", body: `¿Pudiste ${lt}? Si ya está, dímelo y lo quito.` },
    { title: "Sigue pendiente", body: `Sigue pendiente: ${lt}. ¿Te lo quitas de encima ahora?` },
    { title: "Una vez más", body: `Te lo recuerdo otra vez, sin agobios: ${lt} 🙂` },
    { title: "Casi acabando el día", body: `Antes de que acabe el día: ${lt}.` },
    { title: "Último aviso de hoy", body: `Último aviso de hoy: ${lt}. Si ya está, dímelo y lo cierro.` },
  ];
  return variants[Math.min(index, variants.length - 1)]!;
}

/** Desplaza un instante fuera de los compromisos (al final del que lo pisa). */
export function avoidBusy(at: number, busy: DayFrame["busy"]): number {
  let t = at;
  for (const b of [...busy].sort((a, c) => a.start - c.start)) {
    if (t >= b.start && t < b.end) t = b.end + 10 * 60_000;
  }
  return t;
}

/**
 * Siguiente aviso para un pendiente, o null si hoy ya no toca.
 * Solo recordatorios y tareas con fecha de hoy o vencida.
 */
export function nextNudge(p: PendingRow, frame: DayFrame, now: number): NudgeDecision | null {
  if (p.status !== "open" || (p.kind !== "reminder" && p.kind !== "task")) return null;
  if (!p.due_date || p.due_date > frame.date) return null;
  if (p.snoozed_until && Date.parse(p.snoozed_until) > now) {
    // Pospuesto: el siguiente aviso es al acabar la espera.
    const at = avoidBusy(Math.max(Date.parse(p.snoozed_until), frame.wake), frame.busy);
    if (at >= frame.quietFrom) return null;
    const sentToday = p.nudge_date === frame.date ? p.nudge_count : 0;
    return { at, index: sentToday, ...nudgeText(p.title, sentToday, p.due_date < frame.date) };
  }
  const overdue = p.due_date < frame.date;
  const sentToday = p.nudge_date === frame.date ? p.nudge_count : 0;
  if (sentToday >= (overdue ? MAX_NUDGES_OVERDUE : MAX_NUDGES_TODAY)) return null;

  let at: number;
  if (sentToday === 0) {
    if (overdue) at = frame.wake + 30 * 60_000;
    else if (p.due_time) at = localToMs(`${frame.date}T${p.due_time}`, frame.tz);
    else {
      // Creado hoy: primer aviso una hora después; si no, media hora tras levantarse.
      const created = Date.parse(p.created_at);
      const createdToday = created >= localToMs(`${frame.date}T00:00`, frame.tz) && created < localToMs(`${addDays(frame.date, 1)}T00:00`, frame.tz);
      at = createdToday ? created + 60 * 60_000 : frame.wake + 30 * 60_000;
    }
  } else {
    const last = p.last_nudge_at ? Date.parse(p.last_nudge_at) : now;
    const gap = overdue ? 8 * 60 : NUDGE_GAPS_MIN[Math.min(sentToday - 1, NUDGE_GAPS_MIN.length - 1)]!;
    at = last + gap * 60_000;
  }
  at = avoidBusy(Math.max(at, frame.wake), frame.busy);
  if (at >= frame.quietFrom) return null;
  return { at, index: sentToday, ...nudgeText(p.title, sentToday, overdue) };
}

/** Avisos de cumpleaños: unos días antes y el mismo día. */
export function birthdayNotices(
  p: PendingRow,
  frame: Pick<DayFrame, "date" | "wake">,
  noticeDays: number,
): { key: string; at: number; title: string; body: string }[] {
  if (p.kind !== "birthday" || p.status !== "open" || !p.due_date) return [];
  const who = p.person || p.title.replace(/^cumplea(ñ|n)os de\s+/i, "");
  const out = [];
  if (p.due_date === frame.date) {
    out.push({
      key: `birthday:${p.id}:${p.due_date}:day`,
      at: frame.wake + 30 * 60_000,
      title: "Hoy es su cumpleaños 🎂",
      body: `Hoy cumple años ${who}. ¿Le escribes?`,
    });
  }
  if (noticeDays > 0 && addDays(p.due_date, -noticeDays) === frame.date) {
    out.push({
      key: `birthday:${p.id}:${p.due_date}:before`,
      at: frame.wake + 60 * 60_000,
      title: "Cumpleaños a la vista",
      body: `El cumpleaños de ${who} es dentro de ${noticeDays} ${noticeDays === 1 ? "día" : "días"}. ¿Quieres preparar algo?`,
    });
  }
  return out;
}
