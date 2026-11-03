import type { SessionPhase } from "@marlon/shared";
import { z } from "zod";
import { addDays, localToUtcIso, toLocalIso } from "../../lib/time";
import { findDoc, KNOWLEDGE_INDEX } from "../../knowledge";
import { forget, findMemories, MEMORY_CATEGORIES, remember } from "../../memory/store";
import {
  currentBook,
  estimateFinish,
  findBook,
  finishBook,
  logReading,
  rateBook,
  readingLogs,
  readingPace,
  startBook,
  tasteProfile,
} from "../../reading/books";
import { MEDITATIONS, pickMeditation, STRETCH_DISCLAIMER, STRETCH_ROUTINES } from "../../wellbeing/guided";
import { activeSession, cancelSession, fmtDuration, intervalPhases, startSession, totalSeconds } from "../../wellbeing/sessions";
import { scheduleStudy } from "../../wellbeing/study";
import { defineTool, ToolError, type Tool, type ToolContext } from "./types";

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");
const today = (ctx: ToolContext) => toLocalIso(ctx.now, ctx.settings.timezone).slice(0, 10);
const secs = (min?: number, sec?: number) => Math.round((min ?? 0) * 60 + (sec ?? 0));

/* ---------------------------- temporizadores ---------------------------- */

export const startTimer = defineTool({
  name: "start_timer",
  description:
    "Arranca un temporizador por intervalos ('30 minutos de estudio, 5 de descanso, 4 veces' o '40 segundos de ejercicio, 20 de descanso, 8 rondas'). Avisa en cada cambio de fase con una notificación, también con el móvil bloqueado.",
  schema: z.object({
    label: z.string().max(40).optional().describe("Nombre de la fase de trabajo: 'Estudio', 'Ejercicio'…"),
    work_minutes: z.number().min(0).max(240).optional(),
    work_seconds: z.number().int().min(0).max(3600).optional(),
    rest_minutes: z.number().min(0).max(120).optional(),
    rest_seconds: z.number().int().min(0).max(3600).optional(),
    rounds: z.number().int().min(1).max(50).default(1),
  }),
  async run(a, ctx) {
    const work = secs(a.work_minutes, a.work_seconds);
    if (work < 5) throw new ToolError("Falta la duración de la fase de trabajo.", "Usa work_minutes o work_seconds.");
    const label = a.label ?? "Trabajo";
    const phases = intervalPhases({ workSeconds: work, restSeconds: secs(a.rest_minutes, a.rest_seconds), rounds: a.rounds, workLabel: label });
    const title = `${label}: ${fmtDuration(work)}${phases.some((p) => p.kind === "rest") ? ` + ${fmtDuration(secs(a.rest_minutes, a.rest_seconds))} de descanso` : ""} × ${a.rounds}`;
    const s = await startSession(ctx.env, { kind: "timer", title, phases }, ctx.now);
    ctx.out.session = s;
    return { started: title, total: fmtDuration(totalSeconds(phases)), phases: phases.length, ends_at: toLocalIso(ctx.now + totalSeconds(phases) * 1000, ctx.settings.timezone) };
  },
});

export const stopTimer = defineTool({
  name: "stop_timer",
  description: "Para y cancela el temporizador, la meditación o los estiramientos en curso.",
  schema: z.object({}),
  async run(_a, ctx) {
    const s = await activeSession(ctx.db, ctx.now);
    if (!s) throw new ToolError("No hay nada en marcha.");
    await cancelSession(ctx.env, s.id);
    return { stopped: s.title };
  },
});

async function freeMinutesNow(ctx: ToolContext): Promise<number | null> {
  const tz = ctx.settings.timezone;
  const events = await ctx.calendar.list(new Date(ctx.now).toISOString(), localToUtcIso(`${addDays(today(ctx), 1)}T00:00`, tz));
  const next = events.find((e) => !e.allDay && Date.parse(e.start) > ctx.now);
  return next ? Math.floor((Date.parse(next.start) - ctx.now) / 60_000) - ctx.settings.defaultCommuteMin : null;
}

export const startMeditation = defineTool({
  name: "start_meditation",
  description: "Meditación guiada de 3, 5 o 10 minutos. Sin duración, elige según el tiempo libre hasta el próximo compromiso.",
  schema: z.object({ minutes: z.union([z.literal(3), z.literal(5), z.literal(10)]).optional() }),
  async run(a, ctx) {
    const free = a.minutes ? null : await freeMinutesNow(ctx);
    const m = pickMeditation(free, a.minutes);
    const med = MEDITATIONS[m];
    const s = await startSession(ctx.env, { kind: "meditation", title: med.title, phases: med.phases as SessionPhase[] }, ctx.now);
    ctx.out.session = s;
    return { started: med.title, minutes: m, free_minutes_before_next_commitment: free ?? undefined };
  },
});

export const startStretching = defineTool({
  name: "start_stretching",
  description: "Rutina de estiramientos guiada paso a paso: después del gimnasio (post_gym) o tras muchas horas programando (desk).",
  schema: z.object({ routine: z.enum(["post_gym", "desk"]) }),
  async run(a, ctx) {
    const r = STRETCH_ROUTINES[a.routine];
    const s = await startSession(ctx.env, { kind: "stretch", title: r.title, phases: r.phases as unknown as SessionPhase[] }, ctx.now);
    ctx.out.session = s;
    return { started: r.title, minutes: Math.round(totalSeconds(s.phases) / 60), steps: r.phases.map((p) => p.label), safety: STRETCH_DISCLAIMER };
  },
});

export const planStudyBlocks = defineTool({
  name: "plan_study_blocks",
  description:
    "Coloca bloques de estudio en el calendario buscando buenos huecos, repartidos en varios días y con descansos proporcionales (por defecto 50 min + 10 de descanso).",
  schema: z.object({
    subject: z.string().min(1).max(80),
    total_minutes: z.number().int().min(15).max(3000),
    from_date: LocalDate.optional(),
    to_date: LocalDate.optional().describe("Fecha límite, p. ej. el día antes del examen."),
    block_minutes: z.number().int().min(15).max(180).optional(),
    max_blocks_per_day: z.number().int().min(1).max(8).optional(),
  }),
  async run(a, ctx) {
    const from = a.from_date ?? today(ctx);
    const to = a.to_date ?? addDays(from, 6);
    if (to < from) throw new ToolError("La fecha final es anterior a la inicial.");
    const r = await scheduleStudy(ctx.calendar, ctx.settings, {
      subject: a.subject,
      fromDate: from,
      toDate: to,
      totalMinutes: a.total_minutes,
      blockMinutes: a.block_minutes,
      maxBlocksPerDay: a.max_blocks_per_day,
      now: ctx.now,
    });
    if (r.sessions.length) ctx.out.quickReplies.push("Empieza el temporizador de estudio");
    return {
      block_minutes: r.blockMinutes,
      break_minutes: r.breakMinutes,
      sessions: r.sessions.map((s) => `${s.start.slice(0, 10)} ${s.start.slice(11)}-${s.end.slice(11)} (${s.blocks} bloques)`),
      missing_blocks: r.missingBlocks || undefined,
      note: r.missingBlocks ? "No caben todos los bloques en esas fechas: propón ampliar plazo o bloques más largos." : undefined,
    };
  },
});

/* -------------------------------- lectura -------------------------------- */

async function bookFor(ctx: ToolContext, title?: string) {
  const b = title ? await findBook(ctx.db, title) : await currentBook(ctx.db);
  if (!b) throw new ToolError("No sé qué libro estás leyendo.", "Pregunta el título y usa start_book.");
  return b;
}

async function status(ctx: ToolContext, bookId: string, percent: number) {
  const tz = ctx.settings.timezone;
  const pace = readingPace(await readingLogs(ctx.db, bookId));
  const events = await ctx.calendar.list(new Date(ctx.now).toISOString(), localToUtcIso(`${addDays(today(ctx), 60)}T00:00`, tz));
  const est = estimateFinish({ percent, pace, events, tz, now: ctx.now, tripMinutes: ctx.settings.defaultCommuteMin });
  return {
    percent,
    pace_percent_per_trip: pace ? Math.round(pace * ctx.settings.defaultCommuteMin * 10) / 10 : null,
    remaining_minutes: est.remainingMinutes,
    remaining_bus_trips: est.remainingTrips,
    estimated_finish: est.finishDate,
    note: pace === null ? "Aún no hay ritmo: con un par de trayectos más lo calculo." : undefined,
  };
}

export const startBookTool = defineTool({
  name: "start_book",
  description: "Empieza a seguir un libro nuevo (Kindle).",
  schema: z.object({
    title: z.string().min(1).max(200),
    author: z.string().max(100).optional(),
    genre: z.string().max(60).optional(),
    percent: z.number().min(0).max(100).optional(),
  }),
  async run(a, ctx) {
    const b = await startBook(ctx.db, { title: a.title, author: a.author, genre: a.genre, percent: a.percent }, ctx.now);
    return { started: { title: b.title, author: b.author, genre: b.genre, percent: b.percent } };
  },
});

export const logReadingTool = defineTool({
  name: "log_reading",
  description:
    "Apunta por dónde va el libro ('voy por el 40 %'). Por defecto cuenta como un trayecto en bus; si dice los minutos, úsalos. Devuelve el ritmo, lo que falta y cuándo lo terminará. Si llega al 100 %, pide nota y opinión.",
  schema: z.object({
    percent: z.number().min(0).max(100),
    book: z.string().optional().describe("Título si no es el libro actual."),
    minutes: z.number().int().min(1).max(600).optional(),
  }),
  async run(a, ctx) {
    const b = await bookFor(ctx, a.book);
    await logReading(ctx.db, b.id, a.percent, a.minutes ?? ctx.settings.defaultCommuteMin, ctx.now);
    if (a.percent >= 100) {
      ctx.out.quickReplies.push("Un 5 de 5", "Un 4 de 5", "Un 3 de 5", "Un 2 de 5");
      return { book: b.title, finished: true, ask: "¡Terminado! Pide una nota del 1 al 5 y su opinión con sus palabras, y guárdalas con finish_book." };
    }
    return { book: b.title, ...(await status(ctx, b.id, a.percent)) };
  },
});

export const finishBookTool = defineTool({
  name: "finish_book",
  description: "Marca el libro como terminado y guarda la nota (1 a 5) y la opinión, para ir aprendiendo sus gustos.",
  schema: z.object({
    rating: z.number().int().min(1).max(5).optional(),
    opinion: z.string().max(2000).optional(),
    book: z.string().optional(),
  }),
  async run(a, ctx) {
    const b = a.book ? await findBook(ctx.db, a.book) : ((await currentBook(ctx.db)) ?? (await findBook(ctx.db, "")));
    if (!b) throw new ToolError("No encuentro el libro.");
    if (b.status === "finished") await rateBook(ctx.db, b.id, a.rating ?? null, a.opinion ?? null);
    else await finishBook(ctx.db, b.id, a.rating ?? null, a.opinion ?? null, ctx.now);
    return { finished: b.title, rating: a.rating, saved_opinion: Boolean(a.opinion) };
  },
});

export const readingStatus = defineTool({
  name: "reading_status",
  description: "Estado de la lectura actual: por dónde va, ritmo, cuánto falta y cuándo lo terminará.",
  schema: z.object({}),
  async run(_a, ctx) {
    const b = await currentBook(ctx.db);
    if (!b) return { reading: null, message: "No hay ningún libro en marcha." };
    return { book: b.title, author: b.author, ...(await status(ctx, b.id, b.percent)) };
  },
});

export const suggestBooks = defineTool({
  name: "suggest_books",
  description:
    "Datos para sugerir el siguiente libro: libros terminados con nota y opinión, géneros probados y géneros variados por probar. Al principio (pocos libros) propone géneros variados.",
  schema: z.object({}),
  async run(_a, ctx) {
    return tasteProfile(ctx.db);
  },
});

/* ------------------------------- memoria ------------------------------- */

export const rememberFact = defineTool({
  name: "remember_fact",
  description:
    "Guarda algo que has aprendido de Ángel (gustos, rutinas, preferencias de horario, personas). Frase corta en tercera persona: 'Prefiere entrenar antes de las 10'. Si ya había algo parecido, se actualiza.",
  schema: z.object({ content: z.string().min(3).max(500), category: z.enum(MEMORY_CATEGORIES).default("other") }),
  async run(a, ctx) {
    const r = await remember(ctx.db, a.content, a.category);
    return { saved: r.memory.content, updated_existing: r.updated };
  },
});

export const forgetFact = defineTool({
  name: "forget_fact",
  description: "Borra un recuerdo (por id, o buscando por texto) cuando ya no es cierto o lo pide.",
  schema: z.object({ id: z.string().optional(), query: z.string().optional() }).refine((v) => v.id || v.query, "Indica id o query."),
  async run(a, ctx) {
    if (a.id) {
      if (!(await forget(ctx.db, a.id))) throw new ToolError("Ese recuerdo no existe.");
      return { forgotten: a.id };
    }
    const found = await findMemories(ctx.db, a.query!);
    if (found.length !== 1) return { candidates: found.map((m) => ({ id: m.id, content: m.content })), message: found.length ? "Hay varios: pregunta cuál." : "No encuentro ninguno." };
    await forget(ctx.db, found[0]!.id);
    return { forgotten: found[0]!.content };
  },
});

/* -------------------------- base de conocimiento -------------------------- */

export const consultKnowledge = defineTool({
  name: "consult_knowledge",
  description: `Consulta una guía fiable antes de aconsejar sobre sueño, entrenamiento, nutrición vegana, estudio, finanzas o meditación y estiramientos, y cita sus fuentes. Guías: ${KNOWLEDGE_INDEX}.`,
  schema: z.object({ topic: z.string().min(2).max(100) }),
  async run(a) {
    const d = findDoc(a.topic);
    if (!d) throw new ToolError("No tengo una guía sobre eso.", "Di que no tienes una fuente fiable y no inventes datos.");
    return { title: d.title, guide: d.body, sources: d.sources };
  },
});

export const WELLBEING_TOOLS: Tool[] = [
  startTimer,
  stopTimer,
  startMeditation,
  startStretching,
  planStudyBlocks,
  startBookTool,
  logReadingTool,
  finishBookTool,
  readingStatus,
  suggestBooks,
  rememberFact,
  forgetFact,
  consultKnowledge,
] as Tool[];
