import type { CalendarEvent } from "@marlon/shared";
import type { CalendarService } from "../calendar/service";
import { toLocalIso } from "../lib/time";

export interface Conflict {
  date: string;
  work: { id: string; start: string; end: string };
  other: { id: string; title: string; kind: CalendarEvent["kind"]; start: string; end: string };
}

/** Pares (turno de trabajo, otro evento) que se solapan. Horas en local. */
export function findOverlaps(events: CalendarEvent[], tz: string, otherKinds: CalendarEvent["kind"][] = ["university"]): Conflict[] {
  const work = events.filter((e) => e.kind === "work_planned" && !e.allDay);
  const others = events.filter((e) => otherKinds.includes(e.kind) && !e.allDay);
  const out: Conflict[] = [];
  for (const w of work) {
    for (const o of others) {
      if (o.start < w.end && o.end > w.start) {
        const ws = toLocalIso(Date.parse(w.start), tz);
        out.push({
          date: ws.slice(0, 10),
          work: { id: w.id, start: ws, end: toLocalIso(Date.parse(w.end), tz) },
          other: {
            id: o.id,
            title: o.title,
            kind: o.kind,
            start: toLocalIso(Date.parse(o.start), tz),
            end: toLocalIso(Date.parse(o.end), tz),
          },
        });
      }
    }
  }
  return out.sort((a, b) => a.work.start.localeCompare(b.work.start));
}

export async function conflictsInRange(calendar: CalendarService, fromIso: string, toIso: string): Promise<Conflict[]> {
  return findOverlaps(await calendar.list(fromIso, toIso), calendar.tz);
}
