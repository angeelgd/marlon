import { z } from "zod";
import { addDays, localToUtcIso, toLocalIso } from "../../lib/time";
import { planDeparture } from "../../integrations/routes";
import { getForecast } from "../../integrations/weather";
import { mondayOfDate, replanGymWeek } from "../../planning/apply";
import { eveningReview, morningBriefing } from "../../planning/briefing";
import { conflictsInRange } from "../../planning/conflicts";
import { planSleep, toCommitments, type Gym } from "../../planning/sleep";
import { syncUniversity } from "../../university/sync";
import { defineTool, ToolError, type Tool, type ToolContext } from "./types";

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");
const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Formato YYYY-MM-DDTHH:MM en hora local");

const today = (ctx: ToolContext) => toLocalIso(ctx.now, ctx.settings.timezone).slice(0, 10);
const briefingDeps = (ctx: ToolContext) => ({
  db: ctx.db,
  calendar: ctx.calendar,
  settings: ctx.settings,
  mapsKey: ctx.env.GOOGLE_MAPS_API_KEY,
  now: ctx.now,
  fetchImpl: ctx.fetchImpl,
});

function minutesLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

export const importUniversityCalendar = defineTool({
  name: "import_university_calendar",
  description:
    "Sincroniza ahora el calendario de la uni (iCal de Lukkari) con el calendario, sin duplicar, y devuelve los solapes entre turnos de trabajo y clases.",
  schema: z.object({}),
  async run(_a, ctx) {
    const r = await syncUniversity(ctx.env, ctx.calendar, ctx.settings, { now: ctx.now, fetchImpl: ctx.fetchImpl });
    if (r.skipped) {
      throw new ToolError(
        "No hay calendario de la uni configurado.",
        "Explica que hay que guardar la URL iCal de Lukkari como secreto UNIVERSITY_ICAL_URL.",
      );
    }
    return {
      created: r.created,
      changed: r.changed,
      removed: r.removed,
      unchanged: r.unchanged,
      failed: r.failed.length ? r.failed : undefined,
      work_class_overlaps: r.conflicts.map((c) => `${c.date}: turno ${c.work.start.slice(11)}-${c.work.end.slice(11)} con "${c.other.title}" ${c.other.start.slice(11)}-${c.other.end.slice(11)}`),
    };
  },
});

export const findConflicts = defineTool({
  name: "find_conflicts",
  description: "Busca turnos de trabajo que se solapan con clases entre dos fechas.",
  schema: z.object({ from_date: LocalDate, to_date: LocalDate }),
  async run(a, ctx) {
    const tz = ctx.settings.timezone;
    const list = await conflictsInRange(ctx.calendar, localToUtcIso(`${a.from_date}T00:00`, tz), localToUtcIso(`${addDays(a.to_date, 1)}T00:00`, tz));
    return { overlaps: list };
  },
});

export const planGymWeekTool = defineTool({
  name: "plan_gym_week",
  description:
    "Planifica (y guarda) las sesiones de gimnasio de una semana: 3 o 4, preferiblemente por la mañana, sin recortar nunca las 8 horas de sueño. Sustituye solo las sesiones futuras que creó Marlon. Usa durations cuando el usuario diga cuánto va a estar un día con hueco justo, y skip_dates para días que no quiere ir.",
  schema: z.object({
    week_start: LocalDate.optional().describe("Cualquier fecha de la semana; por defecto, la actual."),
    durations: z
      .array(z.object({ date: LocalDate, minutes: z.number().int().min(30).max(300) }))
      .default([]),
    skip_dates: z.array(LocalDate).default([]),
    apply: z.boolean().default(true),
  }),
  async run(a, ctx) {
    const monday = mondayOfDate(a.week_start ?? today(ctx));
    const r = await replanGymWeek(ctx.calendar, ctx.settings, monday, ctx.now, {
      durations: Object.fromEntries(a.durations.map((d) => [d.date, d.minutes])),
      skipDates: a.skip_dates,
      apply: a.apply,
    });
    // Una pregunta cada vez: la del primer día con hueco justo.
    const tight = r.sessions.find((s) => s.tight && !a.durations.some((d) => d.date === s.date));
    if (tight) {
      const opts = [ctx.settings.gymBlockMinMin, Math.round((ctx.settings.gymBlockMinMin + tight.available) / 2 / 5) * 5, tight.available]
        .filter((v, i, arr) => v <= tight.available && arr.indexOf(v) === i)
        .map(minutesLabel);
      ctx.out.quickReplies.push(...opts.slice(0, 3));
    }
    return {
      week: r.week,
      sessions: r.sessions.map((s) => `${s.start.slice(0, 10)} ${s.start.slice(11)}-${s.end.slice(11)}${s.tight ? ` (hueco justo: ${s.available} min)` : ""}`),
      saved: a.apply,
      created: r.created,
      changed: r.changed,
      removed: r.removed,
      below_target: r.belowTarget || undefined,
      days_without_room: r.noRoom.length ? r.noRoom : undefined,
      ask_duration_for: tight ? { date: tight.date, available_minutes: tight.available } : undefined,
      sleep_warnings: r.sleepWarnings.length ? r.sleepWarnings : undefined,
      failed: r.failed.length ? r.failed : undefined,
    };
  },
});

export const getSleepPlan = defineTool({
  name: "get_sleep_plan",
  description:
    "Calcula a qué hora levantarse y acostarse cada día (8 horas mínimo), hacia atrás desde el primer compromiso, contando el gimnasio.",
  schema: z.object({ from_date: LocalDate, to_date: LocalDate }),
  async run(a, ctx) {
    if (a.to_date < a.from_date) throw new ToolError("to_date es anterior a from_date.");
    const tz = ctx.settings.timezone;
    const events = await ctx.calendar.list(localToUtcIso(`${addDays(a.from_date, -1)}T00:00`, tz), localToUtcIso(`${addDays(a.to_date, 2)}T00:00`, tz));
    const gyms = new Map<string, Gym>();
    for (const e of events.filter((e) => e.kind === "gym")) {
      gyms.set(toLocalIso(Date.parse(e.start), tz).slice(0, 10), { start: Date.parse(e.start), end: Date.parse(e.end) });
    }
    const dates: string[] = [];
    for (let d = a.from_date; d <= a.to_date && dates.length < 31; d = addDays(d, 1)) dates.push(d);
    return {
      days: planSleep(dates, toCommitments(events), ctx.settings, gyms).map((d) => ({
        date: d.date,
        wake: toLocalIso(d.wake, tz).slice(11),
        bed_night_before: toLocalIso(d.bedBefore, tz),
        because_of: d.anchor?.title ?? null,
        ok: d.ok,
        short_by_min: d.shortByMin || undefined,
      })),
    };
  },
});

export const getRoute = defineTool({
  name: "get_route",
  description:
    "Calcula a qué hora salir de casa en transporte público para llegar a un evento (con el margen de los ajustes) y si la bici es buena opción. Usa event_id, o destination + arrive_by.",
  schema: z
    .object({
      event_id: z.string().optional(),
      destination: z.string().max(300).optional(),
      arrive_by: LocalDateTime.optional(),
    })
    .refine((v) => v.event_id || (v.destination && v.arrive_by), "Indica event_id, o destination y arrive_by."),
  async run(a, ctx) {
    const tz = ctx.settings.timezone;
    let event;
    if (a.event_id) {
      event = await ctx.calendar.get(a.event_id);
      if (!event) throw new ToolError("No existe ese evento.", "Usa list_events para ver los ids.");
    } else {
      // Evento ficticio: la llegada pedida más el margen.
      const start = Date.parse(localToUtcIso(a.arrive_by!, tz)) + ctx.settings.arrivalMarginMin * 60_000;
      event = {
        id: "adhoc",
        title: a.destination!,
        start: new Date(start).toISOString(),
        end: new Date(start + 60 * 60_000).toISOString(),
        kind: "manual" as const,
        location: a.destination!,
      };
    }
    return planDeparture({ db: ctx.db, event, settings: ctx.settings, mapsKey: ctx.env.GOOGLE_MAPS_API_KEY, fetchImpl: ctx.fetchImpl });
  },
});

export const getWeather = defineTool({
  name: "get_weather",
  description: "Previsión del tiempo en la ciudad de los ajustes (hoy y los dos días siguientes).",
  schema: z.object({ date: LocalDate.optional() }),
  async run(a, ctx) {
    const f = await getForecast(ctx.db, ctx.settings, ctx.fetchImpl);
    const date = a.date ?? today(ctx);
    const day = f.daily.find((d) => d.date === date);
    if (!day) throw new ToolError("Solo tengo previsión para hoy y los dos días siguientes.");
    const hours = f.hourly
      .filter((h) => h.time.startsWith(date))
      .filter((_, i) => i % 3 === 0)
      .map((h) => `${h.time.slice(11)} ${Math.round(h.temperature)}°C ${h.description}, lluvia ${h.precipitationProbability}%`);
    return { city: f.city, day, every_3h: hours };
  },
});

export const getDailyBriefing = defineTool({
  name: "get_daily_briefing",
  description:
    "Datos para el saludo de buenos días: tiempo, eventos de hoy, carga del día, a qué hora salir para el próximo compromiso, gimnasio y sueño.",
  schema: z.object({}),
  async run(_a, ctx) {
    return morningBriefing(briefingDeps(ctx));
  },
});

export const getEveningReview = defineTool({
  name: "get_evening_review",
  description: "Datos para el repaso corto de la noche: qué hay mañana, a qué hora salir, a qué hora acostarse hoy y levantarse mañana.",
  schema: z.object({}),
  async run(_a, ctx) {
    return eveningReview(briefingDeps(ctx));
  },
});

export const PHASE2_TOOLS: Tool[] = [
  importUniversityCalendar,
  findConflicts,
  planGymWeekTool,
  getSleepPlan,
  getRoute,
  getWeather,
  getDailyBriefing,
  getEveningReview,
] as Tool[];
