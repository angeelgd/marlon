import { addDays, localToMs, toLocalParts } from "../lib/time";
import {
  commitmentsOn,
  earliestBed,
  latestWake,
  planSleep,
  type Commitment,
  type DaySleep,
  type Gym,
  type PlanSettings,
} from "./sleep";

/**
 * Planificador del gimnasio.
 * - Objetivo: entre gymSessionsMin y gymSessionsMax sesiones por semana.
 * - Bloque flexible de gymBlockMinMin a gymBlockMaxMin (incluye el trayecto).
 * - Prefiere la mañana; si no hay hueco, usa la tarde o la noche.
 * - Nunca recorta el sueño: el bloque tiene que caber entre la hora de
 *   levantarse más temprana posible y la de acostarse necesaria.
 */

const MIN = 60_000;

export interface GymCandidate {
  date: string;
  start: number;
  end: number;
  /** El hueco no da para el bloque completo: hay que preguntar cuánto tiempo. */
  tight: boolean;
  morning: boolean;
  /** Minutos disponibles en el hueco elegido. */
  available: number;
}

export interface GymPlan {
  sessions: GymCandidate[];
  /** Días sin hueco suficiente (ni siquiera el bloque mínimo). */
  noRoom: string[];
  /** true si no se llega al mínimo de sesiones. */
  belowTarget: boolean;
  sleep: DaySleep[];
}

interface Window {
  start: number;
  end: number;
}

function subtract(window: Window, busy: Window[]): Window[] {
  let free: Window[] = [window];
  for (const b of busy) {
    const next: Window[] = [];
    for (const f of free) {
      if (b.end <= f.start || b.start >= f.end) next.push(f);
      else {
        if (b.start > f.start) next.push({ start: f.start, end: b.start });
        if (b.end < f.end) next.push({ start: b.end, end: f.end });
      }
    }
    free = next;
  }
  return free;
}

/** Mejor hueco para el gimnasio en una fecha, o null si no cabe. */
export function bestGymSlot(
  date: string,
  commitments: Commitment[],
  s: PlanSettings,
  notBefore: number,
): GymCandidate | null {
  const tz = s.timezone;
  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const today = commitmentsOn(date, commitments, tz);

  // Límite inferior: lo más pronto que se puede levantar (sin recortar sueño) y empezar el día.
  const prevBed = earliestBed(commitmentsOn(prev, commitments, tz), null, s);
  const earliestWake = prevBed !== null ? prevBed + s.sleepHours * 60 * MIN : -Infinity;
  const lower = Math.max(
    earliestWake + s.gymMorningPrepMin * MIN,
    localToMs(`${date}T${s.dayStart}`, tz),
    notBefore,
  );
  // Límite superior: acostarse a tiempo para el día siguiente.
  const { wake: nextWake } = latestWake(next, commitmentsOn(next, commitments, tz), null, s);
  const bedTonight = nextWake - s.sleepHours * 60 * MIN;
  const dayEndMs =
    s.dayEnd <= s.dayStart ? localToMs(`${next}T${s.dayEnd}`, tz) : localToMs(`${date}T${s.dayEnd}`, tz);
  const upper = Math.min(bedTonight - s.windDownMin * MIN, dayEndMs);
  if (upper - lower < s.gymBlockMinMin * MIN) return null;

  // Ocupado: compromisos con el trayecto antes y después, y el rato tras el gimnasio.
  const busy = commitments
    .filter((c) => c.end > lower - 12 * 60 * MIN && c.start < upper + 12 * 60 * MIN)
    .map((c) => ({
      start: c.start - (s.defaultCommuteMin + s.gymAfterMin) * MIN,
      end: c.end + s.defaultCommuteMin * MIN,
    }));
  const windows = subtract({ start: lower, end: upper }, busy).filter((w) => w.end - w.start >= s.gymBlockMinMin * MIN);
  if (windows.length === 0) return null;

  const firstCommit = today[0]?.start ?? Infinity;
  const noon = localToMs(`${date}T12:00`, tz);
  const freeWakeStart = localToMs(`${date}T${s.freeDayWake}`, tz) + s.gymMorningPrepMin * MIN;
  const ceil5 = (ms: number) => Math.ceil(ms / (5 * MIN)) * 5 * MIN;
  const floor5 = (ms: number) => Math.floor(ms / (5 * MIN)) * 5 * MIN;

  const options = windows.map((w): GymCandidate | null => {
    const available = Math.floor((w.end - w.start) / MIN);
    const morning = w.start < noon;
    const beforeFirst = w.end <= firstCommit;
    let start: number;
    // Por la mañana, a la hora normal de levantarse si cabe el bloque entero.
    const relaxed = ceil5(Math.max(w.start, freeWakeStart));
    if (morning && w.end - relaxed >= s.gymBlockMaxMin * MIN) {
      start = relaxed;
    } else if (morning && beforeFirst && firstCommit !== Infinity) {
      // Hueco justo antes del primer compromiso: lo más tarde posible (más sueño).
      const dur = Math.min(s.gymBlockMaxMin * MIN, floor5(w.end - ceil5(w.start)));
      start = floor5(w.end - dur);
    } else {
      start = ceil5(w.start);
    }
    const dur = Math.min(s.gymBlockMaxMin * MIN, floor5(w.end - start));
    if (dur < s.gymBlockMinMin * MIN) return null;
    return { date, start, end: start + dur, tight: available < s.gymBlockMaxMin, morning, available };
  });
  const valid = options.filter((o): o is GymCandidate => o !== null);
  if (valid.length === 0) return null;
  // Preferencia: mañana (si así se quiere), luego bloque completo, luego lo más temprano.
  valid.sort(
    (a, b) =>
      Number(s.gymPreferMorning && b.morning) - Number(s.gymPreferMorning && a.morning) ||
      Number(a.tight) - Number(b.tight) ||
      a.start - b.start,
  );
  return valid[0]!;
}

function score(c: GymCandidate, s: PlanSettings): number {
  return (s.gymPreferMorning && c.morning ? 3 : 0) + (c.tight ? 0 : 1);
}

export function planGymWeek(dates: string[], commitments: Commitment[], s: PlanSettings, now: number): GymPlan {
  const candidates = new Map<string, GymCandidate>();
  const noRoom: string[] = [];
  for (const d of dates) {
    const dayEnd = localToMs(`${addDays(d, 1)}T00:00`, s.timezone);
    if (dayEnd <= now) continue; // días pasados
    const c = bestGymSlot(d, commitments, s, now);
    if (c) candidates.set(d, c);
    else noRoom.push(d);
  }

  const target = Math.max(s.gymSessionsMin, Math.min(s.gymSessionsMax, candidates.size));
  const ranked = [...candidates.values()].sort((a, b) => score(b, s) - score(a, s) || a.start - b.start);
  const chosen = new Map<string, GymCandidate>();
  const adjacent = (d: string) => chosen.has(addDays(d, -1)) || chosen.has(addDays(d, 1));

  // Primero sin días seguidos (descanso entre sesiones); si no llega, se permiten.
  for (const allowAdjacent of [false, true]) {
    for (const c of ranked) {
      if (chosen.size >= Math.min(target, s.gymSessionsMax)) break;
      if (chosen.has(c.date)) continue;
      if (!allowAdjacent && adjacent(c.date)) continue;
      chosen.set(c.date, c);
    }
    if (chosen.size >= s.gymSessionsMin) break;
  }

  const sessions = [...chosen.values()].sort((a, b) => a.start - b.start);
  const gyms = new Map<string, Gym>(sessions.map((g) => [g.date, { start: g.start, end: g.end }]));
  return {
    sessions,
    noRoom,
    belowTarget: sessions.length < s.gymSessionsMin,
    sleep: planSleep(dates, commitments, s, gyms),
  };
}

/** Fecha local de un instante (atajo). */
export const dateOf = (ms: number, tz: string) => toLocalParts(ms, tz).date;
