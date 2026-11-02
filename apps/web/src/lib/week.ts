import { addDays, localToUtcIso, toLocalParts, weekdayOf } from "@marlon/shared";

/** Lunes (fecha local) de la semana que contiene `ms`. */
export function mondayOf(ms: number, tz: string): string {
  const { date } = toLocalParts(ms, tz);
  const wd = weekdayOf(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function weekRange(monday: string, tz: string) {
  return { from: localToUtcIso(`${monday}T00:00`, tz), to: localToUtcIso(`${addDays(monday, 7)}T00:00`, tz) };
}

export function dayLabel(date: string): { short: string; num: string } {
  const d = new Date(`${date}T12:00:00Z`);
  return {
    short: new Intl.DateTimeFormat("es-ES", { weekday: "short", timeZone: "UTC" }).format(d).replace(".", ""),
    num: String(Number(date.slice(8, 10))),
  };
}

export function monthLabel(monday: string): string {
  const d = new Date(`${monday}T12:00:00Z`);
  return new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

export function timeLabel(iso: string, tz: string): string {
  return toLocalParts(Date.parse(iso), tz).time;
}

export interface Segment {
  key: string;
  /** Fecha local de la columna. */
  date: string;
  /** Minutos desde las 00:00 de esa fecha. */
  startMin: number;
  endMin: number;
  first: boolean;
}

/** Parte un evento en tramos por día (para turnos que cruzan la medianoche). */
export function segmentsOf(startIso: string, endIso: string, tz: string, days: string[]): Segment[] {
  const out: Segment[] = [];
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  let first = true;
  for (const date of days) {
    const dayStart = Date.parse(localToUtcIso(`${date}T00:00`, tz));
    const dayEnd = Date.parse(localToUtcIso(`${addDays(date, 1)}T00:00`, tz));
    if (e <= dayStart || s >= dayEnd) continue;
    const from = Math.max(s, dayStart);
    const to = Math.min(e, dayEnd);
    out.push({
      key: date,
      date,
      startMin: (from - dayStart) / 60_000,
      endMin: (to - dayStart) / 60_000,
      first: first && from === s,
    });
    first = false;
  }
  return out;
}
