import type { CalendarEvent, Settings } from "@marlon/shared";
import type { CalendarService } from "../calendar/service";
import { addDays, localToMs, localToUtcIso, toLocalIso, toLocalParts } from "../lib/time";
import { planDeparture, type Departure } from "../integrations/routes";
import { getForecast, weatherAt } from "../integrations/weather";
import { findOverlaps } from "./conflicts";
import { planSleep, toCommitments, type Gym } from "./sleep";

/**
 * Datos para el "buenos días" y el repaso de la noche. Marlon los convierte
 * en un mensaje con su tono; aquí solo se reúne la información.
 */

export interface BriefingDeps {
  db: D1Database;
  calendar: CalendarService;
  settings: Settings;
  mapsKey?: string;
  now: number;
  fetchImpl?: typeof fetch;
}

const COMMITMENT_KINDS: CalendarEvent["kind"][] = ["work_planned", "university", "marlon", "manual", "gym"];

export function loadLevel(events: CalendarEvent[], date: string, s: Settings): { level: "tranquilo" | "moderado" | "cargado"; busyMinutes: number } {
  const from = localToMs(`${date}T${s.dayStart}`, s.timezone);
  const to = localToMs(`${date}T${s.dayEnd}`, s.timezone);
  let busy = 0;
  for (const e of events) {
    if (e.allDay) continue;
    const a = Math.max(from, Date.parse(e.start));
    const b = Math.min(to, Date.parse(e.end));
    if (b > a) busy += (b - a) / 60_000;
  }
  const ratio = busy / Math.max(1, (to - from) / 60_000);
  return { level: ratio < 0.25 ? "tranquilo" : ratio < 0.55 ? "moderado" : "cargado", busyMinutes: Math.round(busy) };
}

async function dayContext(deps: BriefingDeps, date: string) {
  const { calendar, settings: s } = deps;
  const tz = s.timezone;
  // Un día antes y uno después para el sueño.
  const all = await calendar.list(localToUtcIso(`${addDays(date, -1)}T00:00`, tz), localToUtcIso(`${addDays(date, 2)}T00:00`, tz));
  const ofDay = all.filter((e) => toLocalParts(Date.parse(e.start), tz).date === date);
  const gyms = new Map<string, Gym>();
  for (const e of all.filter((e) => e.kind === "gym")) {
    gyms.set(toLocalParts(Date.parse(e.start), tz).date, { start: Date.parse(e.start), end: Date.parse(e.end) });
  }
  const commitments = toCommitments(all);
  const [today, tomorrow] = planSleep([date, addDays(date, 1)], commitments, s, gyms);
  return { all, ofDay, gyms, today: today!, tomorrow: tomorrow! };
}

const present = (e: CalendarEvent, tz: string) => ({
  title: e.title,
  kind: e.kind,
  start: toLocalIso(Date.parse(e.start), tz).slice(11),
  end: toLocalIso(Date.parse(e.end), tz).slice(11),
  all_day: e.allDay || undefined,
});

async function firstDeparture(deps: BriefingDeps, events: CalendarEvent[], after: number): Promise<Departure | null> {
  const next = events.find((e) => !e.allDay && COMMITMENT_KINDS.includes(e.kind) && Date.parse(e.start) > after);
  if (!next) return null;
  return planDeparture({ db: deps.db, event: next, settings: deps.settings, mapsKey: deps.mapsKey, fetchImpl: deps.fetchImpl });
}

async function weatherFor(deps: BriefingDeps, date: string, hourIso?: string) {
  try {
    const f = await getForecast(deps.db, deps.settings, deps.fetchImpl);
    const day = f.daily.find((d) => d.date === date) ?? null;
    const now = hourIso ? weatherAt(f, hourIso) : null;
    return {
      city: f.city,
      now: now && { temperature: Math.round(now.temperature), description: now.description, rain_probability: now.precipitationProbability },
      day: day && {
        max: Math.round(day.max),
        min: Math.round(day.min),
        description: day.description,
        rain_probability: day.precipitationProbabilityMax,
        sunrise: day.sunrise.slice(11),
        sunset: day.sunset.slice(11),
      },
    };
  } catch (err) {
    return { error: `No pude consultar el tiempo: ${(err as Error).message}` };
  }
}

export async function morningBriefing(deps: BriefingDeps) {
  const s = deps.settings;
  const tz = s.timezone;
  const nowLocal = toLocalIso(deps.now, tz);
  const date = nowLocal.slice(0, 10);
  const ctx = await dayContext(deps, date);
  const gym = ctx.gyms.get(date);
  return {
    enabled: s.morningBriefing,
    now: nowLocal,
    weekday: new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "long" }).format(new Date(deps.now)),
    weather: await weatherFor(deps, date, nowLocal),
    day_load: loadLevel(ctx.ofDay, date, s),
    events: ctx.ofDay.map((e) => present(e, tz)),
    leave_for_next: await firstDeparture(deps, ctx.ofDay, deps.now),
    gym_today: gym ? { start: toLocalIso(gym.start, tz).slice(11), end: toLocalIso(gym.end, tz).slice(11) } : null,
    sleep: {
      planned_wake_today: toLocalIso(ctx.today.wake, tz).slice(11),
      bed_tonight: toLocalIso(ctx.tomorrow.bedBefore, tz).slice(11),
      tonight_ok: ctx.tomorrow.ok,
      tonight_short_by_min: ctx.tomorrow.shortByMin || undefined,
    },
    conflicts: findOverlaps(ctx.ofDay, tz),
  };
}

export async function eveningReview(deps: BriefingDeps) {
  const s = deps.settings;
  const tz = s.timezone;
  const today = toLocalIso(deps.now, tz).slice(0, 10);
  const tomorrow = addDays(today, 1);
  const ctx = await dayContext(deps, tomorrow);
  const gym = ctx.gyms.get(tomorrow);
  return {
    enabled: s.eveningReview,
    now: toLocalIso(deps.now, tz),
    tomorrow,
    tomorrow_weekday: new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "long" }).format(
      new Date(localToMs(`${tomorrow}T12:00`, tz)),
    ),
    weather_tomorrow: await weatherFor(deps, tomorrow),
    events_tomorrow: ctx.ofDay.map((e) => present(e, tz)),
    day_load_tomorrow: loadLevel(ctx.ofDay, tomorrow, s),
    first_departure_tomorrow: await firstDeparture(deps, ctx.ofDay, deps.now),
    gym_tomorrow: gym ? { start: toLocalIso(gym.start, tz).slice(11), end: toLocalIso(gym.end, tz).slice(11) } : null,
    sleep: {
      bed_tonight: toLocalIso(ctx.today.bedBefore, tz),
      wake_tomorrow: toLocalIso(ctx.today.wake, tz),
      ok: ctx.today.ok,
      short_by_min: ctx.today.shortByMin || undefined,
      reason: ctx.today.anchor ? `primer compromiso: ${ctx.today.anchor.title}` : "día sin compromisos por la mañana",
    },
    conflicts_tomorrow: findOverlaps(ctx.ofDay, tz),
  };
}
