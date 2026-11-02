import { z } from "zod";
import type { CalendarEvent } from "@marlon/shared";
import { addDays, localToUtcIso, toLocalIso } from "../../lib/time";
import { ConsentRequiredError } from "../../llm/provider";
import {
  applyCorrections,
  applyImport,
  buildPreview,
  discardUpload,
  findConflicts,
  loadUpload,
  saveUpload,
  transcribeSchedule,
  updateUploadParsed,
} from "../../schedule/import";
import { coveredRange, parseSchedule, type ParseResult } from "../../schedule/parse";
import { replanGymWeek, weeksInRange } from "../../planning/apply";
import { findFreeSlots } from "../../schedule/slots";
import { defineTool, ToolError, type Tool, type ToolContext } from "./types";

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");
const LocalDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Formato YYYY-MM-DDTHH:MM en hora local");
const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM");

function present(e: CalendarEvent, tz: string) {
  return {
    id: e.id,
    title: e.title,
    start: e.allDay ? e.start.slice(0, 10) : toLocalIso(Date.parse(e.start), tz),
    end: e.allDay ? e.end.slice(0, 10) : toLocalIso(Date.parse(e.end), tz),
    all_day: e.allDay || undefined,
    kind: e.kind,
    location: e.location || undefined,
  };
}

const tz = (ctx: ToolContext) => ctx.settings.timezone;

export const listEvents = defineTool({
  name: "list_events",
  description: "Lista los eventos del calendario entre dos fechas locales (ambas incluidas).",
  schema: z.object({ from_date: LocalDate, to_date: LocalDate }),
  async run(a, ctx) {
    if (a.to_date < a.from_date) throw new ToolError("to_date es anterior a from_date.");
    const events = await ctx.calendar.list(
      localToUtcIso(`${a.from_date}T00:00`, tz(ctx)),
      localToUtcIso(`${addDays(a.to_date, 1)}T00:00`, tz(ctx)),
    );
    return { events: events.map((e) => present(e, tz(ctx))) };
  },
});

export const createEvent = defineTool({
  name: "create_event",
  description: "Crea un evento en el calendario. Horas en hora local.",
  schema: z.object({
    title: z.string().min(1).max(200),
    start: LocalDateTime,
    end: LocalDateTime,
    location: z.string().max(300).optional(),
    description: z.string().max(2000).optional(),
  }),
  async run(a, ctx) {
    const ev = await ctx.calendar.create({
      title: a.title,
      start: localToUtcIso(a.start, tz(ctx)),
      end: localToUtcIso(a.end, tz(ctx)),
      location: a.location ?? null,
      description: a.description ?? null,
      kind: "marlon",
    });
    return { event: present(ev, tz(ctx)) };
  },
});

export const moveEvent = defineTool({
  name: "move_event",
  description:
    "Mueve un evento a otra hora. Si no se indica new_end, se mantiene la duración. Usa el id que devuelve list_events.",
  schema: z.object({ event_id: z.string().min(1), new_start: LocalDateTime, new_end: LocalDateTime.optional() }),
  async run(a, ctx) {
    const ev = await ctx.calendar.move(
      a.event_id,
      localToUtcIso(a.new_start, tz(ctx)),
      a.new_end ? localToUtcIso(a.new_end, tz(ctx)) : null,
    );
    return { event: present(ev, tz(ctx)) };
  },
});

export const deleteEvent = defineTool({
  name: "delete_event",
  description: "Borra un evento del calendario. Se puede deshacer desde el historial.",
  schema: z.object({ event_id: z.string().min(1) }),
  async run(a, ctx) {
    const ev = await ctx.calendar.remove(a.event_id);
    return { deleted: present(ev, tz(ctx)) };
  },
});

export const findFreeSlotsTool = defineTool({
  name: "find_free_slots",
  description:
    "Busca huecos libres de al menos duration_minutes entre dos fechas, dentro de la franja diaria (por defecto la de ajustes). Devuelve tramos libres completos.",
  schema: z.object({
    from_date: LocalDate,
    to_date: LocalDate,
    duration_minutes: z.number().int().min(5).max(24 * 60),
    day_start: HHMM.optional(),
    day_end: HHMM.optional(),
    buffer_minutes: z.number().int().min(0).max(120).optional(),
  }),
  async run(a, ctx) {
    if (a.to_date < a.from_date) throw new ToolError("to_date es anterior a from_date.");
    const zone = tz(ctx);
    const events = await ctx.calendar.list(
      localToUtcIso(`${addDays(a.from_date, -1)}T00:00`, zone),
      localToUtcIso(`${addDays(a.to_date, 2)}T00:00`, zone),
    );
    const slots = findFreeSlots({
      fromDate: a.from_date,
      toDate: a.to_date,
      durationMin: a.duration_minutes,
      dayStart: a.day_start ?? ctx.settings.dayStart,
      dayEnd: a.day_end ?? ctx.settings.dayEnd,
      tz: zone,
      bufferMin: a.buffer_minutes,
      notBefore: ctx.now,
      busy: events.filter((e) => !e.allDay).map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) })),
    });
    return {
      slots: slots.map((s) => ({ date: s.date, start: toLocalIso(s.start, zone), end: toLocalIso(s.end, zone), minutes: s.minutes })),
    };
  },
});

export const parseSchedulePhoto = defineTool({
  name: "parse_schedule_photo",
  description:
    "Lee la foto del horario de trabajo adjunta, se queda con la columna del usuario y prepara una vista previa. Si no hay dudas y está activado el guardado automático, la guarda y devuelve el resumen.",
  schema: z.object({
    image_index: z.number().int().min(0).default(0),
    column_name: z.string().min(1).optional().describe("Solo si el usuario pide otra columna distinta de la de ajustes."),
    allow_free_tier: z
      .boolean()
      .optional()
      .describe("true solo si el usuario ha aceptado expresamente enviar la foto por la capa gratuita."),
  }),
  async run(a, ctx) {
    const imageId = ctx.imageIds[a.image_index];
    if (!imageId) throw new ToolError("No hay ninguna imagen adjunta con ese índice.", "Pide al usuario que adjunte la foto.");
    const img = await ctx.db
      .prepare(`SELECT mime, data FROM pending_images WHERE id = ?`)
      .bind(imageId)
      .first<{ mime: string; data: string }>();
    if (!img) throw new ToolError("La imagen ya no está disponible.", "Pide al usuario que la vuelva a enviar.");

    const column = a.column_name ?? ctx.settings.scheduleColumnName;
    let llm;
    try {
      llm = ctx.llm({
        sensitivity: "third_party",
        allowFreeTier: a.allow_free_tier || ctx.settings.allowFreeTierForSchedulePhoto,
      });
    } catch (err) {
      if (err instanceof ConsentRequiredError) {
        ctx.out.quickReplies.push("Sí, envíala igualmente", "No, la recorto antes");
        return {
          needs_consent: true,
          message:
            "La foto lleva nombres y horarios de compañeros y solo hay clave de capa gratuita (Google puede usar esos datos para entrenar). Pregunta si quiere enviarla igualmente o recortarla antes.",
        };
      }
      throw err;
    }

    const vision = await transcribeSchedule(llm, img, column);
    if (!vision.column_found) {
      const cols = vision.available_columns?.filter(Boolean) ?? [];
      if (cols.length) ctx.out.quickReplies.push(...cols.slice(0, 4));
      return {
        column_found: false,
        available_columns: cols,
        message: `No encuentro la columna "${column}". Pregunta cuál es la suya.`,
      };
    }

    const today = toLocalIso(ctx.now, tz(ctx)).slice(0, 10);
    const parsed = parseSchedule(vision.rows, today);
    const uploadId = await saveUpload(ctx.db, vision.rows, parsed);
    await ctx.db.prepare(`DELETE FROM pending_images WHERE id = ?`).bind(imageId).run();
    const conflicts = await findConflicts(ctx.calendar, parsed, tz(ctx));

    if (parsed.issues.length === 0 && parsed.shifts.length + parsed.daysOff.length > 0 && ctx.settings.autoConfirmCleanSchedule) {
      const res = await applyImport(ctx.db, ctx.calendar, uploadId, ctx.settings);
      ctx.out.preview = await buildPreview(ctx.calendar, uploadId, parsed, ctx.settings, "confirmed");
      return {
        saved: true,
        upload_id: uploadId,
        shifts: parsed.shifts.map((s) => `${s.date} ${s.start}-${s.end}`),
        days_off: parsed.daysOff,
        created: res.created,
        changed: res.changed,
        removed: res.removed,
        unchanged: res.unchanged,
        conflicts_with_other_events: conflicts,
        failed: res.failed.length ? res.failed : undefined,
        gym_replanned: await replanAfterSchedule(ctx, parsed, res.groupId),
        summary: `He guardado ${parsed.shifts.length} turnos (${res.created} nuevos, ${res.changed} cambiados, ${res.removed} quitados).`,
      };
    }

    ctx.out.preview = await buildPreview(ctx.calendar, uploadId, parsed, ctx.settings);
    if (parsed.issues.length) ctx.out.quickReplies.push("Guárdalo así", "Descartar");
    else ctx.out.quickReplies.push("Sí, guárdalo", "Descartar");
    return {
      saved: false,
      upload_id: uploadId,
      shifts: parsed.shifts.map((s) => `${s.date} ${s.start}-${s.end}${s.flagged ? " (dudoso)" : ""}`),
      days_off: parsed.daysOff,
      issues: parsed.issues.map((i) => i.message),
      conflicts_with_other_events: conflicts,
      message: parsed.issues.length
        ? "Hay dudas. Pregúntalas una a una y, con las respuestas, llama a confirm_schedule_import con corrections."
        : "Pide confirmación antes de guardar.",
    };
  },
});

export const confirmScheduleImport = defineTool({
  name: "confirm_schedule_import",
  description:
    "Guarda (o descarta) una lectura del horario pendiente. Admite correcciones por fecha. Sobrescribe solo el horario planificado de esas fechas.",
  schema: z.object({
    upload_id: z.string().min(1),
    action: z.enum(["confirm", "discard"]).default("confirm"),
    corrections: z
      .array(
        z.object({
          date: LocalDate,
          start: HHMM.optional(),
          end: HHMM.optional(),
          day_off: z.boolean().optional(),
        }),
      )
      .default([]),
    accept_remaining_issues: z
      .boolean()
      .default(false)
      .describe("true si el usuario dice que lo guarde tal cual pese a las dudas."),
  }),
  async run(a, ctx) {
    const up = await loadUpload(ctx.db, a.upload_id);
    if (!up) throw new ToolError("No encuentro esa lectura del horario.");
    if (a.action === "discard") {
      await discardUpload(ctx.db, a.upload_id);
      return { discarded: true, summary: "Vale, descarto esa lectura del horario." };
    }
    let parsed = applyCorrections(up.parsed, a.corrections);
    if (a.accept_remaining_issues) {
      parsed = { ...parsed, issues: [], shifts: parsed.shifts.map((s) => ({ ...s, flagged: false })) };
    }
    await updateUploadParsed(ctx.db, a.upload_id, parsed);
    if (parsed.issues.length) {
      ctx.out.preview = await buildPreview(ctx.calendar, a.upload_id, parsed, ctx.settings);
      return { saved: false, remaining_issues: parsed.issues.map((i) => i.message) };
    }
    const res = await applyImport(ctx.db, ctx.calendar, a.upload_id, ctx.settings);
    ctx.out.preview = await buildPreview(ctx.calendar, a.upload_id, parsed, ctx.settings, "confirmed");
    return {
      saved: true,
      ...res,
      gym_replanned: await replanAfterSchedule(ctx, parsed, res.groupId),
      summary: `Horario guardado: ${res.created} nuevos, ${res.changed} cambiados, ${res.removed} quitados.`,
    };
  },
});

/**
 * Con un horario nuevo, Marlon reajusta él solo el gimnasio de esas semanas
 * y lo cuenta después.
 */
async function replanAfterSchedule(ctx: ToolContext, parsed: ParseResult, groupId: string) {
  const range = coveredRange(parsed);
  if (!range) return undefined;
  const out = [];
  for (const monday of weeksInRange(range.from, range.to, toLocalIso(ctx.now, tz(ctx)).slice(0, 10))) {
    try {
      const r = await replanGymWeek(ctx.calendar, ctx.settings, monday, ctx.now, { groupId });
      out.push({
        week: monday,
        sessions: r.sessions.map((x) => `${x.start.slice(0, 10)} ${x.start.slice(11)}-${x.end.slice(11)}${x.tight ? " (justo)" : ""}`),
        changes: r.created + r.changed + r.removed,
        below_target: r.belowTarget || undefined,
        sleep_warnings: r.sleepWarnings.length ? r.sleepWarnings : undefined,
      });
    } catch (err) {
      out.push({ week: monday, error: (err as Error).message });
    }
  }
  return out;
}

export const PHASE1_TOOLS: Tool[] = [
  listEvents,
  createEvent,
  moveEvent,
  deleteEvent,
  findFreeSlotsTool,
  parseSchedulePhoto,
  confirmScheduleImport,
] as Tool[];
