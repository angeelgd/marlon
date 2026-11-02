import type { PreviewEvent, SchedulePreview, Settings } from "@marlon/shared";
import { z } from "zod";
import type { CalendarService } from "../calendar/service";
import { newGroupId } from "../calendar/service";
import { newId, nowIso } from "../lib/ids";
import { localToUtcIso } from "../lib/time";
import type { LlmProvider } from "../llm/provider";
import { addDays } from "../lib/time";
import { coveredRange, parseSchedule, shiftEndDate, type ParseResult, type ParsedShift, type RawRow } from "./parse";

/* ------------------------------------------------------------------ */
/* Visión: transcribir la columna                                       */
/* ------------------------------------------------------------------ */

const RawRowSchema = z.object({
  date: z.string().nullable().catch(null),
  weekday: z.string().nullable().catch(null),
  start: z.string().nullable().catch(null),
  end: z.string().nullable().catch(null),
  hours: z.string().nullable().catch(null),
});

export const VisionOutputSchema = z.object({
  column_found: z.boolean(),
  column_name: z.string().nullable().optional(),
  available_columns: z.array(z.string()).optional(),
  rows: z.array(RawRowSchema).default([]),
});

export function visionPrompt(column: string): string {
  return [
    "You are transcribing a work schedule screenshot of a spreadsheet.",
    `Only read the date column, the weekday column, and the columns that belong to the person "${column}".`,
    "Ignore every other person's columns completely.",
    "For each row, copy the cell text EXACTLY as shown, without converting or computing anything:",
    '- date: as written, e.g. "Oct-19"',
    '- weekday: as written, e.g. "Sun"',
    `- start and end: ${column}'s start and end times as written, e.g. "15.45" and "22.00". Empty string if the cell is empty.`,
    `- hours: the worked hours cell for ${column} as written, e.g. "6,25" or "0,00". Empty string if empty.`,
    "Horizontal lines only separate weeks; do not output rows for them.",
    "Keep the original row order.",
    `If you cannot find a column for "${column}", set column_found to false and list the person names you can see in available_columns.`,
    'Answer with JSON only: {"column_found": boolean, "column_name": string, "available_columns": string[], "rows": [{"date": string, "weekday": string, "start": string, "end": string, "hours": string}]}',
  ].join("\n");
}

export async function transcribeSchedule(
  llm: LlmProvider,
  image: { mime: string; data: string },
  column: string,
): Promise<z.infer<typeof VisionOutputSchema>> {
  const res = await llm.chat({
    vision: true,
    json: true,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: visionPrompt(column) },
          { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } },
        ],
      },
    ],
  });
  const text = (res.content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("El modelo no devolvió una tabla legible a partir de la foto.");
  }
  return VisionOutputSchema.parse(json);
}

/* ------------------------------------------------------------------ */
/* Vista previa                                                         */
/* ------------------------------------------------------------------ */

export const workKey = (date: string) => `work:${date}`;

export function shiftInstants(s: Pick<ParsedShift, "date" | "start" | "end" | "endsNextDay">, tz: string) {
  return {
    start: localToUtcIso(`${s.date}T${s.start}`, tz),
    end: localToUtcIso(`${shiftEndDate(s)}T${s.end}`, tz),
  };
}

export async function buildPreview(
  calendar: CalendarService,
  uploadId: string,
  parsed: ParseResult,
  settings: Settings,
  status: SchedulePreview["status"] = "pending",
): Promise<SchedulePreview> {
  const tz = settings.timezone;
  const events: PreviewEvent[] = [];
  const flaggedDates = new Set(parsed.issues.map((i) => i.date).filter(Boolean));

  for (const s of parsed.shifts) {
    const { start, end } = shiftInstants(s, tz);
    const existing = await calendar.findByKey(workKey(s.date));
    let st: PreviewEvent["status"] = "new";
    if (s.flagged || flaggedDates.has(s.date)) st = "issue";
    else if (existing) st = existing.start === start && existing.end === end ? "unchanged" : "changed";
    events.push({ key: workKey(s.date), title: settings.workEventTitle, start, end, status: st });
  }
  for (const d of parsed.daysOff) {
    const existing = await calendar.findByKey(workKey(d));
    if (existing) {
      events.push({ key: workKey(d), title: `${existing.title} (se quita)`, start: existing.start, end: existing.end, status: "removed" });
    }
  }
  return {
    uploadId,
    status,
    shifts: parsed.shifts.map(({ flagged: _f, ...s }) => s),
    daysOff: parsed.daysOff,
    issues: parsed.issues,
    events,
  };
}

/* ------------------------------------------------------------------ */
/* Guardar, leer y aplicar                                              */
/* ------------------------------------------------------------------ */

export async function saveUpload(db: D1Database, raw: RawRow[], parsed: ParseResult): Promise<string> {
  const id = newId("upl");
  await db
    .prepare(`INSERT INTO schedule_uploads (id, created_at, status, raw_json, parsed_json, issues_json) VALUES (?, ?, 'pending', ?, ?, ?)`)
    .bind(id, nowIso(), JSON.stringify(raw), JSON.stringify(parsed), JSON.stringify(parsed.issues))
    .run();
  return id;
}

export async function loadUpload(
  db: D1Database,
  id: string,
): Promise<{ status: SchedulePreview["status"]; parsed: ParseResult; groupId: string | null } | null> {
  const r = await db
    .prepare(`SELECT status, parsed_json, group_id FROM schedule_uploads WHERE id = ?`)
    .bind(id)
    .first<{ status: SchedulePreview["status"]; parsed_json: string; group_id: string | null }>();
  return r ? { status: r.status, parsed: JSON.parse(r.parsed_json) as ParseResult, groupId: r.group_id } : null;
}

export interface Correction {
  date: string;
  start?: string;
  end?: string;
  day_off?: boolean;
}

/** Aplica correcciones del usuario sobre lo leído y quita las incidencias resueltas. */
export function applyCorrections(parsed: ParseResult, corrections: Correction[]): ParseResult {
  const shifts = parsed.shifts.filter((s) => !corrections.some((c) => c.date === s.date));
  const daysOff = parsed.daysOff.filter((d) => !corrections.some((c) => c.date === d));
  const issues = parsed.issues.filter((i) => !i.date || !corrections.some((c) => c.date === i.date));
  for (const c of corrections) {
    if (c.day_off) {
      daysOff.push(c.date);
      continue;
    }
    const prev = parsed.shifts.find((s) => s.date === c.date);
    const start = c.start ?? prev?.start;
    const end = c.end ?? prev?.end;
    if (!start || !end) throw new Error(`Para corregir el ${c.date} necesito la hora de entrada y la de salida.`);
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const endsNextDay = toMin(end) <= toMin(start);
    const duration = (endsNextDay ? toMin(end) + 1440 : toMin(end)) - toMin(start);
    shifts.push({ date: c.date, start, end, endsNextDay, hours: Math.round((duration / 60) * 100) / 100, flagged: false });
  }
  shifts.sort((a, b) => a.date.localeCompare(b.date));
  daysOff.sort();
  return { shifts, daysOff, issues };
}

export async function updateUploadParsed(db: D1Database, id: string, parsed: ParseResult): Promise<void> {
  await db
    .prepare(`UPDATE schedule_uploads SET parsed_json = ?, issues_json = ? WHERE id = ?`)
    .bind(JSON.stringify(parsed), JSON.stringify(parsed.issues), id)
    .run();
}

export async function discardUpload(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE schedule_uploads SET status = 'discarded' WHERE id = ? AND status = 'pending'`).bind(id).run();
}

export interface ApplyResult {
  groupId: string;
  created: number;
  changed: number;
  removed: number;
  unchanged: number;
}

/**
 * Guarda el horario planificado: solo toca los eventos de trabajo planificado
 * (marlonKey "work:FECHA") de las fechas que aparecen en la foto.
 * Nunca toca las horas reales (otra tabla, fase 4).
 */
export async function applyImport(
  db: D1Database,
  calendar: CalendarService,
  uploadId: string,
  settings: Settings,
): Promise<ApplyResult> {
  const up = await loadUpload(db, uploadId);
  if (!up) throw new Error("No encuentro esa lectura del horario.");
  if (up.status !== "pending") throw new Error("Esa lectura del horario ya se había guardado o descartado.");
  const blocking = up.parsed.issues.filter((i) => i.kind !== "duplicate_date");
  if (blocking.length) {
    throw new Error(`Quedan ${blocking.length} dudas por resolver antes de guardar.`);
  }

  const tz = settings.timezone;
  const groupId = newGroupId();
  const meta = { actor: "marlon" as const, groupId };
  const result: ApplyResult = { groupId, created: 0, changed: 0, removed: 0, unchanged: 0 };

  for (const s of up.parsed.shifts) {
    const { start, end } = shiftInstants(s, tz);
    const existing = await calendar.findByKey(workKey(s.date));
    let eventId: string;
    if (!existing) {
      const ev = await calendar.create(
        {
          title: settings.workEventTitle,
          start,
          end,
          location: settings.workLocation || null,
          kind: "work_planned",
          marlonKey: workKey(s.date),
        },
        meta,
      );
      eventId = ev.id;
      result.created++;
    } else if (existing.start !== start || existing.end !== end) {
      const ev = await calendar.move(existing.id, start, end, meta);
      eventId = ev.id;
      result.changed++;
    } else {
      eventId = existing.id;
      result.unchanged++;
    }
    await db
      .prepare(
        `INSERT INTO planned_shifts (date, start_time, end_time, ends_next_day, hours, source_upload_id, event_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(date) DO UPDATE SET start_time = ?2, end_time = ?3, ends_next_day = ?4, hours = ?5,
           source_upload_id = ?6, event_id = ?7, updated_at = ?8`,
      )
      .bind(s.date, s.start, s.end, s.endsNextDay ? 1 : 0, s.hours, uploadId, eventId, nowIso())
      .run();
  }

  for (const d of up.parsed.daysOff) {
    const existing = await calendar.findByKey(workKey(d));
    if (existing) {
      await calendar.remove(existing.id, meta);
      result.removed++;
    }
    await db.prepare(`DELETE FROM planned_shifts WHERE date = ?`).bind(d).run();
  }

  await db
    .prepare(`UPDATE schedule_uploads SET status = 'confirmed', group_id = ? WHERE id = ?`)
    .bind(groupId, uploadId)
    .run();
  return result;
}

/** Turnos planificados que se solapan con otros eventos (p. ej. clases). */
export async function findConflicts(calendar: CalendarService, parsed: ParseResult, tz: string) {
  const range = coveredRange(parsed);
  if (!range) return [];
  const others = (
    await calendar.list(localToUtcIso(`${range.from}T00:00`, tz), localToUtcIso(`${addDays(range.to, 2)}T00:00`, tz))
  ).filter((e) => e.kind !== "work_planned" && !e.allDay);
  const out: { date: string; event: string }[] = [];
  for (const s of parsed.shifts) {
    const { start, end } = shiftInstants(s, tz);
    for (const e of others) {
      if (e.start < end && e.end > start) out.push({ date: s.date, event: e.title });
    }
  }
  return out;
}
