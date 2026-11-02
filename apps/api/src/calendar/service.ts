import type { CalendarEvent, ChangeAction, ChangeLogEntry, EventKind } from "@marlon/shared";
import { newId, nowIso } from "../lib/ids";
import { anyToMs } from "../lib/time";
import type { CalendarBackend, EventInput, RemoteEvent } from "./backend";

interface CacheRow {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  all_day: number;
  location: string | null;
  description: string | null;
  kind: string;
  marlon_key: string | null;
}

interface LogRow {
  id: string;
  created_at: string;
  actor: "marlon" | "user";
  action: ChangeAction;
  event_id: string | null;
  summary: string;
  before_json: string | null;
  after_json: string | null;
  group_id: string | null;
  undone_at: string | null;
}

export interface ChangeMeta {
  actor?: "marlon" | "user";
  groupId?: string | null;
}

const rowToEvent = (r: CacheRow): CalendarEvent => ({
  id: r.id,
  title: r.title,
  start: r.start_at,
  end: r.end_at,
  allDay: r.all_day === 1,
  location: r.location,
  description: r.description,
  kind: r.kind as EventKind,
  marlonKey: r.marlon_key,
});

/**
 * Punto único para leer y escribir el calendario.
 * Mantiene la copia local en D1 y deja cada cambio en el historial.
 */
export class CalendarService {
  /** IDs de historial creados por esta instancia (un turno de chat). */
  readonly changeIds: string[] = [];

  constructor(
    private readonly db: D1Database,
    readonly backend: CalendarBackend,
    readonly tz: string,
    readonly calendarId: string,
  ) {}

  private norm(iso: string): string {
    return new Date(anyToMs(iso, this.tz)).toISOString();
  }

  private fmt(iso: string): string {
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: this.tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  }

  async list(fromIso: string, toIso: string): Promise<CalendarEvent[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM events_cache WHERE deleted = 0 AND start_at < ?1 AND end_at > ?2 ORDER BY start_at`,
      )
      .bind(this.norm(toIso), this.norm(fromIso))
      .all<CacheRow>();
    return results.map(rowToEvent);
  }

  async get(id: string): Promise<CalendarEvent | null> {
    const r = await this.db.prepare(`SELECT * FROM events_cache WHERE id = ? AND deleted = 0`).bind(id).first<CacheRow>();
    return r ? rowToEvent(r) : null;
  }

  async findByKey(key: string): Promise<CalendarEvent | null> {
    const r = await this.db
      .prepare(`SELECT * FROM events_cache WHERE marlon_key = ? AND deleted = 0`)
      .bind(key)
      .first<CacheRow>();
    return r ? rowToEvent(r) : null;
  }

  /** Guarda en la copia local un evento que viene del backend. */
  async upsertCache(ev: RemoteEvent): Promise<void> {
    if (ev.cancelled) {
      await this.db.prepare(`UPDATE events_cache SET deleted = 1, updated_at = ? WHERE id = ?`).bind(nowIso(), ev.id).run();
      return;
    }
    await this.db
      .prepare(
        `INSERT INTO events_cache (id, calendar_id, title, start_at, end_at, all_day, location, description, kind, marlon_key, etag, updated_at, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0)
         ON CONFLICT(id) DO UPDATE SET title = ?3, start_at = ?4, end_at = ?5, all_day = ?6, location = ?7,
           description = ?8, kind = ?9, marlon_key = ?10, etag = ?11, updated_at = ?12, deleted = 0`,
      )
      .bind(
        ev.id,
        this.calendarId,
        ev.title,
        this.norm(ev.start),
        this.norm(ev.end),
        ev.allDay ? 1 : 0,
        ev.location ?? null,
        ev.description ?? null,
        ev.kind,
        ev.marlonKey ?? null,
        ev.etag ?? null,
        nowIso(),
      )
      .run();
  }

  private async log(
    action: ChangeAction,
    eventId: string,
    summary: string,
    before: CalendarEvent | EventInput | null,
    after: CalendarEvent | EventInput | null,
    meta: ChangeMeta,
  ): Promise<string> {
    const id = newId("chg");
    await this.db
      .prepare(
        `INSERT INTO change_log (id, created_at, actor, action, event_id, summary, before_json, after_json, group_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        nowIso(),
        meta.actor ?? "marlon",
        action,
        eventId,
        summary,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        meta.groupId ?? null,
      )
      .run();
    this.changeIds.push(id);
    return id;
  }

  async create(input: EventInput, meta: ChangeMeta = {}): Promise<CalendarEvent> {
    const ev: EventInput = { ...input, start: this.norm(input.start), end: this.norm(input.end) };
    if (Date.parse(ev.end) <= Date.parse(ev.start)) throw new Error("El final del evento debe ser posterior al inicio.");
    const remote = await this.backend.insert(ev);
    const stored: RemoteEvent = { ...ev, ...stripEmpty(remote), id: remote.id };
    await this.upsertCache(stored);
    const created = (await this.get(remote.id))!;
    await this.log("create", remote.id, `Creado "${ev.title}" el ${this.fmt(ev.start)}`, null, created, meta);
    return created;
  }

  async move(id: string, start: string, end: string | null, meta: ChangeMeta = {}): Promise<CalendarEvent> {
    const before = await this.get(id);
    if (!before) throw new Error(`No existe el evento ${id}.`);
    const newStart = this.norm(start);
    const duration = Date.parse(before.end) - Date.parse(before.start);
    const newEnd = end ? this.norm(end) : new Date(Date.parse(newStart) + duration).toISOString();
    if (Date.parse(newEnd) <= Date.parse(newStart)) throw new Error("El final del evento debe ser posterior al inicio.");
    const remote = await this.backend.patch(id, { start: newStart, end: newEnd });
    await this.upsertCache({ ...toInput(before), ...stripEmpty(remote), id, start: newStart, end: newEnd });
    const after = (await this.get(id))!;
    await this.log(
      "move",
      id,
      `Movido "${before.title}" del ${this.fmt(before.start)} al ${this.fmt(newStart)}`,
      before,
      after,
      meta,
    );
    return after;
  }

  async update(id: string, fields: Partial<EventInput>, meta: ChangeMeta = {}): Promise<CalendarEvent> {
    const before = await this.get(id);
    if (!before) throw new Error(`No existe el evento ${id}.`);
    const patch: Partial<EventInput> = { ...fields };
    if (patch.start) patch.start = this.norm(patch.start);
    if (patch.end) patch.end = this.norm(patch.end);
    const remote = await this.backend.patch(id, patch);
    await this.upsertCache({ ...toInput(before), ...patch, ...stripEmpty(remote), id } as RemoteEvent);
    const after = (await this.get(id))!;
    const moved = before.start !== after.start || before.end !== after.end;
    await this.log(
      moved ? "move" : "update",
      id,
      moved
        ? `Cambiado "${after.title}" al ${this.fmt(after.start)}`
        : `Actualizado "${after.title}"`,
      before,
      after,
      meta,
    );
    return after;
  }

  async remove(id: string, meta: ChangeMeta = {}): Promise<CalendarEvent> {
    const before = await this.get(id);
    if (!before) throw new Error(`No existe el evento ${id}.`);
    await this.backend.remove(id);
    await this.db.prepare(`UPDATE events_cache SET deleted = 1, updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
    await this.log("delete", id, `Borrado "${before.title}" del ${this.fmt(before.start)}`, before, null, meta);
    return before;
  }

  /* ---------------------------- historial ---------------------------- */

  async history(limit = 50): Promise<ChangeLogEntry[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM change_log ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .bind(limit)
      .all<LogRow>();
    return results.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      actor: r.actor,
      action: r.action,
      eventId: r.event_id,
      summary: r.summary,
      groupId: r.group_id,
      undoneAt: r.undone_at,
    }));
  }

  /** Deshace un cambio, o todo su grupo si pertenece a uno. Devuelve los cambios deshechos. */
  async undo(changeId: string): Promise<number> {
    const entry = await this.db.prepare(`SELECT * FROM change_log WHERE id = ?`).bind(changeId).first<LogRow>();
    if (!entry) throw new Error("Ese cambio no existe.");
    if (entry.undone_at) throw new Error("Ese cambio ya estaba deshecho.");
    const entries = entry.group_id
      ? (
          await this.db
            .prepare(`SELECT * FROM change_log WHERE group_id = ? AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC`)
            .bind(entry.group_id)
            .all<LogRow>()
        ).results
      : [entry];

    let count = 0;
    for (const e of entries) {
      await this.revert(e);
      await this.db.prepare(`UPDATE change_log SET undone_at = ? WHERE id = ?`).bind(nowIso(), e.id).run();
      count++;
    }
    return count;
  }

  private async revert(e: LogRow): Promise<void> {
    const before = e.before_json ? (JSON.parse(e.before_json) as CalendarEvent) : null;
    switch (e.action) {
      case "create": {
        if (!e.event_id) return;
        if (await this.get(e.event_id)) {
          await this.backend.remove(e.event_id);
          await this.db.prepare(`UPDATE events_cache SET deleted = 1 WHERE id = ?`).bind(e.event_id).run();
        }
        return;
      }
      case "move":
      case "update": {
        if (!e.event_id || !before) return;
        const fields = toInput(before);
        const remote = await this.backend.patch(e.event_id, fields);
        await this.upsertCache({ ...fields, ...stripEmpty(remote), id: e.event_id });
        return;
      }
      case "delete": {
        if (!before) return;
        const remote = await this.backend.insert(toInput(before));
        await this.upsertCache({ ...toInput(before), ...stripEmpty(remote), id: remote.id });
        // Los cambios posteriores que apunten al id antiguo pasan al nuevo.
        if (e.event_id) {
          await this.db
            .prepare(`UPDATE change_log SET event_id = ? WHERE event_id = ?`)
            .bind(remote.id, e.event_id)
            .run();
        }
        return;
      }
    }
  }
}

function toInput(ev: CalendarEvent): EventInput & { allDay?: boolean } {
  return {
    title: ev.title,
    start: ev.start,
    end: ev.end,
    location: ev.location ?? null,
    description: ev.description ?? null,
    kind: ev.kind,
    marlonKey: ev.marlonKey ?? null,
    allDay: ev.allDay,
  };
}

/** El backend local devuelve campos vacíos en patch; no deben pisar los datos buenos. */
function stripEmpty(r: RemoteEvent): Partial<RemoteEvent> {
  const out: Partial<RemoteEvent> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v !== "" && v !== undefined && !(k === "kind" && v === "manual")) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function newGroupId(): string {
  return newId("grp");
}
