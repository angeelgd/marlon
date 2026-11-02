import { addDays, localToMs, toLocalParts } from "../lib/time";

export interface Interval {
  start: number; // ms
  end: number; // ms
}

export interface FreeSlotQuery {
  /** Fechas locales YYYY-MM-DD, ambas incluidas. */
  fromDate: string;
  toDate: string;
  durationMin: number;
  /** Ventana diaria en hora local "HH:MM". */
  dayStart: string;
  dayEnd: string;
  tz: string;
  busy: Interval[];
  /** Margen libre alrededor de cada compromiso (minutos). */
  bufferMin?: number;
  /** No devolver huecos que empiecen antes de este instante (p. ej. ahora). */
  notBefore?: number;
}

export interface FreeSlot {
  date: string;
  start: number;
  end: number;
  minutes: number;
}

/** Une intervalos solapados o contiguos. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/**
 * Devuelve los huecos libres, de al menos `durationMin`, dentro de la ventana
 * diaria de cada fecha. Cada hueco es el tramo libre completo (no se trocea),
 * así quien lo usa decide dónde colocar el bloque.
 */
export function findFreeSlots(q: FreeSlotQuery): FreeSlot[] {
  const buffer = (q.bufferMin ?? 0) * 60_000;
  const busy = mergeIntervals(q.busy.map((b) => ({ start: b.start - buffer, end: b.end + buffer })));
  const slots: FreeSlot[] = [];
  const need = q.durationMin * 60_000;

  for (let date = q.fromDate; date <= q.toDate; date = addDays(date, 1)) {
    let winStart = localToMs(`${date}T${q.dayStart}`, q.tz);
    const winEnd =
      q.dayEnd <= q.dayStart
        ? localToMs(`${addDays(date, 1)}T${q.dayEnd}`, q.tz)
        : localToMs(`${date}T${q.dayEnd}`, q.tz);
    if (q.notBefore !== undefined) winStart = Math.max(winStart, q.notBefore);
    if (winEnd - winStart < need) continue;

    let cursor = winStart;
    for (const b of busy) {
      if (b.end <= cursor) continue;
      if (b.start >= winEnd) break;
      if (b.start - cursor >= need) {
        slots.push({ date, start: cursor, end: b.start, minutes: (b.start - cursor) / 60_000 });
      }
      cursor = Math.max(cursor, b.end);
      if (cursor >= winEnd) break;
    }
    if (winEnd - cursor >= need) {
      slots.push({ date, start: cursor, end: winEnd, minutes: (winEnd - cursor) / 60_000 });
    }
  }
  return slots;
}

/** Fecha local de un instante, útil para agrupar huecos por día. */
export function localDateOf(ms: number, tz: string): string {
  return toLocalParts(ms, tz).date;
}
