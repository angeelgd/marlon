import type { CalendarEvent, Settings } from "@marlon/shared";
import { addDays, localToMs, toLocalParts } from "../lib/time";

/**
 * Sueño: 8 horas mínimo, regla intocable.
 * La hora de levantarse se calcula hacia atrás desde el primer compromiso del
 * día (contando el gimnasio si toca) y la de acostarse, 8 horas antes.
 */

export type PlanSettings = Pick<
  Settings,
  | "timezone"
  | "sleepHours"
  | "morningRoutineMin"
  | "windDownMin"
  | "freeDayWake"
  | "defaultCommuteMin"
  | "dayStart"
  | "dayEnd"
  | "gymBlockMinMin"
  | "gymBlockMaxMin"
  | "gymSessionsMin"
  | "gymSessionsMax"
  | "gymPreferMorning"
  | "gymMorningPrepMin"
  | "gymAfterMin"
>;

export interface Commitment {
  start: number;
  end: number;
  title: string;
  kind: CalendarEvent["kind"];
}

const MIN = 60_000;

/** Compromisos que cuentan para el día (todo menos el gimnasio y los de día completo). */
export function toCommitments(events: CalendarEvent[]): Commitment[] {
  return events
    .filter((e) => !e.allDay && e.kind !== "gym")
    .map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end), title: e.title, kind: e.kind }))
    .sort((a, b) => a.start - b.start);
}

/** Compromisos que EMPIEZAN en la fecha local dada. */
export function commitmentsOn(date: string, list: Commitment[], tz: string): Commitment[] {
  return list.filter((c) => toLocalParts(c.start, tz).date === date);
}

export interface Gym {
  start: number;
  end: number;
}

export interface DaySleep {
  date: string;
  /** Hora a la que levantarse ese día. */
  wake: number;
  /** Hora a la que acostarse la noche ANTERIOR para dormir lo necesario. */
  bedBefore: number;
  /** Lo más pronto que se puede acostar la noche anterior (por lo que terminó tarde). */
  earliestBedBefore: number | null;
  /** Qué marca la hora de levantarse. */
  anchor: { title: string; start: number } | null;
  /** false si los compromisos no dejan dormir las horas mínimas. */
  ok: boolean;
  /** Minutos de sueño que faltan si ok es false. */
  shortByMin: number;
}

/** Lo más tarde que se puede levantar ese día. */
export function latestWake(date: string, dayCommitments: Commitment[], gym: Gym | null, s: PlanSettings): {
  wake: number;
  anchor: DaySleep["anchor"];
} {
  const first = dayCommitments[0];
  const candidates: { wake: number; anchor: DaySleep["anchor"] }[] = [];
  if (first) {
    candidates.push({
      wake: first.start - (s.defaultCommuteMin + s.morningRoutineMin) * MIN,
      anchor: { title: first.title, start: first.start },
    });
  }
  if (gym && (!first || gym.start < first.start)) {
    candidates.push({ wake: gym.start - s.gymMorningPrepMin * MIN, anchor: { title: "Gimnasio", start: gym.start } });
  }
  const freeWake = localToMs(`${date}T${s.freeDayWake}`, s.timezone);
  if (candidates.length === 0) return { wake: freeWake, anchor: null };
  const best = candidates.reduce((a, b) => (a.wake <= b.wake ? a : b));
  // En días con compromisos tarde, no hace falta levantarse más tarde que en un día libre.
  return best.wake > freeWake ? { wake: freeWake, anchor: null } : best;
}

/** Lo más pronto que se puede acostar tras el último compromiso que empieza ese día. */
export function earliestBed(dayCommitments: Commitment[], gym: Gym | null, s: PlanSettings): number | null {
  const ends = dayCommitments.map((c) => c.end + s.defaultCommuteMin * MIN);
  if (gym) ends.push(gym.end); // el bloque del gimnasio ya incluye la vuelta
  if (ends.length === 0) return null;
  return Math.max(...ends) + s.windDownMin * MIN;
}

/**
 * Plan de sueño para cada fecha. `gyms` permite contar sesiones ya colocadas.
 */
export function planSleep(
  dates: string[],
  commitments: Commitment[],
  s: PlanSettings,
  gyms: Map<string, Gym> = new Map(),
): DaySleep[] {
  const tz = s.timezone;
  return dates.map((date) => {
    const prev = addDays(date, -1);
    const today = commitmentsOn(date, commitments, tz);
    const { wake, anchor } = latestWake(date, today, gyms.get(date) ?? null, s);
    const bedBefore = wake - s.sleepHours * 60 * MIN;
    const earliest = earliestBed(commitmentsOn(prev, commitments, tz), gyms.get(prev) ?? null, s);
    const short = earliest !== null && earliest > bedBefore ? Math.round((earliest - bedBefore) / MIN) : 0;
    return { date, wake, bedBefore, earliestBedBefore: earliest, anchor, ok: short === 0, shortByMin: short };
  });
}
