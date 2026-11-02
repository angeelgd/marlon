import type { Settings } from "@marlon/shared";
import { newGroupId, type BulkOp, type CalendarService } from "../calendar/service";
import { addDays, localToUtcIso, toLocalIso, weekdayOf } from "../lib/time";
import { planGymWeek, type GymCandidate } from "./gym";
import { toCommitments } from "./sleep";

export const gymKey = (date: string) => `gym:${date}`;

export function mondayOfDate(date: string): string {
  const wd = weekdayOf(date);
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export interface GymReplanResult {
  week: string;
  sessions: { date: string; start: string; end: string; minutes: number; morning: boolean; tight: boolean; available: number }[];
  created: number;
  changed: number;
  removed: number;
  belowTarget: boolean;
  noRoom: string[];
  /** Días en los que no se puede dormir lo mínimo por los compromisos. */
  sleepWarnings: { date: string; shortByMin: number; wake: string }[];
  failed: string[];
  groupId: string | null;
}

export interface ReplanOptions {
  /** Minutos que el usuario quiere para un día concreto (respuesta a "¿cuánto vas a estar?"). */
  durations?: Record<string, number>;
  /** Días en los que no quiere ir. */
  skipDates?: string[];
  apply?: boolean;
  /** Para agrupar con otro cambio (p. ej. la importación del horario) y deshacerlo todo junto. */
  groupId?: string;
}

/**
 * Replanifica el gimnasio de la semana que empieza en `monday`.
 * Solo toca las sesiones futuras que creó Marlon (marlonKey "gym:FECHA").
 */
export async function replanGymWeek(
  calendar: CalendarService,
  settings: Settings,
  monday: string,
  now: number,
  opts: ReplanOptions = {},
): Promise<GymReplanResult> {
  const tz = settings.timezone;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const fromIso = localToUtcIso(`${addDays(monday, -1)}T00:00`, tz);
  const toIso = localToUtcIso(`${addDays(monday, 8)}T00:00`, tz);
  const events = await calendar.list(fromIso, toIso);
  const skip = new Set(opts.skipDates ?? []);

  // Los días que no quiere ir se tratan como ocupados para el gimnasio.
  const blockers = [...skip].map((d) => ({
    id: `skip:${d}`,
    title: "(sin gimnasio)",
    start: localToUtcIso(`${d}T00:00`, tz),
    end: localToUtcIso(`${d}T23:59`, tz),
    kind: "manual" as const,
  }));
  const plan = planGymWeek(dates, toCommitments([...events, ...blockers]), settings, now);

  // Duraciones pedidas por el usuario (dentro del bloque y del hueco disponible).
  const sessions: GymCandidate[] = plan.sessions
    .filter((s) => !skip.has(s.date))
    .map((s) => {
      const wanted = opts.durations?.[s.date];
      if (!wanted) return s;
      const minutes = Math.max(settings.gymBlockMinMin, Math.min(wanted, settings.gymBlockMaxMin, s.available));
      return { ...s, end: s.start + minutes * 60_000, tight: false };
    });

  const result: GymReplanResult = {
    week: monday,
    sessions: sessions.map((s) => ({
      date: s.date,
      start: toLocalIso(s.start, tz),
      end: toLocalIso(s.end, tz),
      minutes: Math.round((s.end - s.start) / 60_000),
      morning: s.morning,
      tight: s.tight,
      available: s.available,
    })),
    created: 0,
    changed: 0,
    removed: 0,
    belowTarget: sessions.length < settings.gymSessionsMin,
    noRoom: plan.noRoom.filter((d) => !skip.has(d)),
    sleepWarnings: plan.sleep
      .filter((d) => !d.ok)
      .map((d) => ({ date: d.date, shortByMin: d.shortByMin, wake: toLocalIso(d.wake, tz) })),
    failed: [],
    groupId: null,
  };
  if (opts.apply === false) return result;

  // Diferencias con lo que ya hay: solo sesiones futuras creadas por Marlon.
  const existing = (await calendar.listByKeyPrefix("gym:", fromIso, toIso)).filter(
    (e) => Date.parse(e.start) > now && dates.includes(e.marlonKey!.slice(4)),
  );
  const byDate = new Map(existing.map((e) => [e.marlonKey!.slice(4), e]));
  const ops: BulkOp[] = [];
  for (const s of sessions) {
    const start = new Date(s.start).toISOString();
    const end = new Date(s.end).toISOString();
    const cur = byDate.get(s.date);
    byDate.delete(s.date);
    if (!cur) {
      ops.push({
        op: "create",
        input: {
          title: "Gimnasio",
          start,
          end,
          location: settings.gymAddress || null,
          description: `Incluye ${settings.gymTravelMin} min de trayecto de ida y ${settings.gymTravelMin} de vuelta.`,
          kind: "gym",
          marlonKey: gymKey(s.date),
        },
      });
    } else if (cur.start !== start || cur.end !== end) {
      ops.push({ op: "move", id: cur.id, start, end });
    }
  }
  for (const e of byDate.values()) ops.push({ op: "remove", id: e.id });

  if (ops.length) {
    result.groupId = opts.groupId ?? newGroupId();
    const { items } = await calendar.bulk(ops, { actor: "marlon", groupId: result.groupId });
    items.forEach((it, i) => {
      if (!it.ok) return void result.failed.push(it.error);
      const op = ops[i]!.op;
      if (op === "create") result.created++;
      else if (op === "remove") result.removed++;
      else result.changed++;
    });
  }
  return result;
}

/** Lunes de las semanas que tocan un rango de fechas (solo las que aún no han acabado). */
export function weeksInRange(from: string, to: string, today: string): string[] {
  const out: string[] = [];
  for (let m = mondayOfDate(from); m <= to; m = addDays(m, 7)) {
    if (addDays(m, 6) >= today) out.push(m);
  }
  return out;
}
