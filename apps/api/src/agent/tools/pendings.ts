import { PendingKindSchema, type Pending } from "@marlon/shared";
import { z } from "zod";
import { localToUtcIso, toLocalIso } from "../../lib/time";
import { addPending, closePending, findPendings, getPending, listPendings, snoozePending } from "../../pendings/store";
import { defineTool, ToolError, type Tool } from "./types";

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");
const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM");

const present = (p: Pending) => ({
  id: p.id,
  kind: p.kind,
  title: p.title,
  person: p.person ?? undefined,
  area: p.area,
  due: p.dueDate ? `${p.dueDate}${p.dueTime ? ` ${p.dueTime}` : ""}` : undefined,
  horizon: p.horizon ?? undefined,
  status: p.status,
});

export const addPendingTool = defineTool({
  name: "add_pending",
  description:
    "Guarda algo que no hay que olvidar: recordatorio ('recuérdame contestar a Mateo'), tarea del trabajo o la uni, plan a corto o largo plazo, o cumpleaños. Un recordatorio sin fecha es para hoy y Marlon insistirá durante el día hasta que se cierre.",
  schema: z.object({
    kind: PendingKindSchema,
    title: z.string().min(1).max(200).describe("Redactado como acción: 'Contestar a Mateo', 'Responder el correo sobre X'."),
    person: z.string().max(100).optional(),
    notes: z.string().max(1000).optional(),
    area: z.enum(["work", "uni", "personal"]).default("personal"),
    due_date: LocalDate.optional(),
    due_time: HHMM.optional(),
    horizon: z.enum(["short", "long"]).optional().describe("Solo planes."),
    birthday: z
      .string()
      .regex(/^(\d{4}-)?\d{2}-\d{2}$/, "MM-DD o YYYY-MM-DD")
      .optional()
      .describe("Solo cumpleaños: el día y el mes."),
  }),
  async run(a, ctx) {
    const p = await addPending(
      ctx.db,
      {
        kind: a.kind,
        title: a.title,
        person: a.person,
        notes: a.notes,
        area: a.area,
        dueDate: a.due_date,
        dueTime: a.due_time,
        horizon: a.horizon,
        birthday: a.birthday,
      },
      ctx.now,
      ctx.settings.timezone,
    );
    return { saved: present(p) };
  },
});

export const closePendingTool = defineTool({
  name: "close_pending",
  description:
    "Marca un pendiente como hecho cuando el usuario dice que ya está ('ya le contesté a Mateo'). Usa id si lo tienes; si no, query con las palabras clave. En cumpleaños, lo pasa al año siguiente.",
  schema: z.object({ id: z.string().optional(), query: z.string().max(200).optional() }).refine((v) => v.id || v.query, "Indica id o query."),
  async run(a, ctx) {
    let target: Pending | null = null;
    if (a.id) target = await getPending(ctx.db, a.id);
    else {
      const found = await findPendings(ctx.db, a.query!);
      if (found.length > 1) {
        ctx.out.quickReplies.push(...found.slice(0, 4).map((p) => p.title));
        return { ambiguous: true, candidates: found.map(present), message: "Hay varios. Pregunta cuál." };
      }
      target = found[0] ?? null;
    }
    if (!target) throw new ToolError("No encuentro ese pendiente.", "Usa list_pendings para ver los abiertos.");
    const closed = await closePending(ctx.db, target.id, ctx.now, ctx.settings.timezone);
    return { closed: present(closed) };
  },
});

export const listPendingsTool = defineTool({
  name: "list_pendings",
  description: "Lista los pendientes abiertos (y los hechos si se pide): recordatorios, tareas, planes y cumpleaños.",
  schema: z.object({ kind: PendingKindSchema.optional(), include_done: z.boolean().default(false) }),
  async run(a, ctx) {
    const all = await listPendings(ctx.db, { includeDone: a.include_done });
    return { pendings: all.filter((p) => !a.kind || p.kind === a.kind).map(present) };
  },
});

export const snoozePendingTool = defineTool({
  name: "snooze_pending",
  description: "Pospone los avisos de un pendiente hasta una hora ('recuérdamelo a las 18:00').",
  schema: z.object({ id: z.string(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "YYYY-MM-DDTHH:MM local") }),
  async run(a, ctx) {
    const p = await getPending(ctx.db, a.id);
    if (!p) throw new ToolError("Ese pendiente no existe.");
    const until = localToUtcIso(a.until, ctx.settings.timezone);
    if (Date.parse(until) <= ctx.now) throw new ToolError("Esa hora ya ha pasado.");
    await snoozePending(ctx.db, a.id, until);
    return { snoozed_until: toLocalIso(Date.parse(until), ctx.settings.timezone), title: p.title };
  },
});

export const PENDING_TOOLS: Tool[] = [addPendingTool, closePendingTool, listPendingsTool, snoozePendingTool] as Tool[];
