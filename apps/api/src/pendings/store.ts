import type { Pending, PendingKind } from "@marlon/shared";
import { newId, nowIso } from "../lib/ids";
import { toLocalIso } from "../lib/time";

/**
 * Pendientes: recordatorios ("contestar a Mateo"), tareas del trabajo o la uni,
 * planes a corto y largo plazo y cumpleaños. Todo lo cuenta el usuario:
 * Marlon no lee chats ni correos.
 */

export interface PendingRow {
  id: string;
  kind: PendingKind;
  title: string;
  person: string | null;
  notes: string | null;
  area: Pending["area"];
  due_date: string | null;
  due_time: string | null;
  birthday_md: string | null;
  horizon: Pending["horizon"];
  status: Pending["status"];
  created_at: string;
  done_at: string | null;
  nudge_date: string | null;
  nudge_count: number;
  last_nudge_at: string | null;
  snoozed_until: string | null;
}

export const rowToPending = (r: PendingRow): Pending => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  person: r.person,
  notes: r.notes,
  area: r.area,
  dueDate: r.due_date,
  dueTime: r.due_time,
  horizon: r.horizon,
  status: r.status,
  createdAt: r.created_at,
  doneAt: r.done_at,
});

/** Próxima fecha (hoy incluido) de un cumpleaños "MM-DD". El 29-02 cae el 28-02 en años no bisiestos. */
export function nextBirthday(md: string, today: string): string {
  const [m, d] = md.split("-").map(Number);
  const year = Number(today.slice(0, 4));
  const make = (y: number) => {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const day = m === 2 && d === 29 && !leap ? 28 : d!;
    return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const thisYear = make(year);
  return thisYear >= today ? thisYear : make(year + 1);
}

export interface NewPending {
  kind: PendingKind;
  title: string;
  person?: string | null;
  notes?: string | null;
  area?: Pending["area"];
  dueDate?: string | null;
  dueTime?: string | null;
  horizon?: Pending["horizon"];
  /** Solo cumpleaños: "MM-DD" o "YYYY-MM-DD". */
  birthday?: string | null;
}

export async function addPending(db: D1Database, input: NewPending, now: number, tz: string): Promise<Pending> {
  const today = toLocalIso(now, tz).slice(0, 10);
  let dueDate = input.dueDate ?? null;
  let birthdayMd: string | null = null;
  if (input.kind === "birthday") {
    const b = input.birthday ?? input.dueDate;
    const m = b ? /(\d{2})-(\d{2})$/.exec(b) : null;
    if (!m) throw new Error("Para un cumpleaños necesito el día y el mes.");
    birthdayMd = `${m[1]}-${m[2]}`;
    dueDate = nextBirthday(birthdayMd, today);
  } else if (input.kind === "reminder" && !dueDate) {
    // Un recordatorio sin fecha es para hoy.
    dueDate = today;
  }
  const id = newId("pnd");
  await db
    .prepare(
      `INSERT INTO pendings (id, kind, title, person, notes, area, due_date, due_time, birthday_md, horizon, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .bind(
      id,
      input.kind,
      input.title.trim(),
      input.person ?? null,
      input.notes ?? null,
      input.area ?? "personal",
      dueDate,
      input.kind === "birthday" ? null : (input.dueTime ?? null),
      birthdayMd,
      input.kind === "plan" ? (input.horizon ?? "short") : null,
      new Date(now).toISOString(),
    )
    .run();
  return (await getPending(db, id))!;
}

export async function getPendingRow(db: D1Database, id: string): Promise<PendingRow | null> {
  return db.prepare(`SELECT * FROM pendings WHERE id = ?`).bind(id).first<PendingRow>();
}

export async function getPending(db: D1Database, id: string): Promise<Pending | null> {
  const r = await getPendingRow(db, id);
  return r ? rowToPending(r) : null;
}

export async function listPendingRows(db: D1Database, opts: { includeDone?: boolean } = {}): Promise<PendingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM pendings WHERE (?1 = 1 OR status = 'open')
       ORDER BY status, CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, due_time, created_at`,
    )
    .bind(opts.includeDone ? 1 : 0)
    .all<PendingRow>();
  return results;
}

export async function listPendings(db: D1Database, opts: { includeDone?: boolean } = {}): Promise<Pending[]> {
  return (await listPendingRows(db, opts)).map(rowToPending);
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const STOP = new Set(["a", "al", "el", "la", "los", "las", "de", "del", "que", "lo", "le", "un", "una", "y", "con", "por", "para", "ya", "to", "the"]);

/** Busca pendientes abiertos que encajen con un texto ("lo de Mateo", "el correo de X"). */
export async function findPendings(db: D1Database, query: string): Promise<Pending[]> {
  const words = norm(query)
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w));
  if (words.length === 0) return [];
  const rows = await listPendingRows(db);
  const scored = rows
    .map((r) => {
      const hay = norm(`${r.title} ${r.person ?? ""} ${r.notes ?? ""}`);
      const hits = words.filter((w) => hay.includes(w)).length;
      return { r, score: hits / words.length };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return [];
  const best = scored[0]!.score;
  return scored.filter((x) => x.score === best).map((x) => rowToPending(x.r));
}

/**
 * Cierra un pendiente. Un cumpleaños no se cierra: pasa al año siguiente.
 */
export async function closePending(db: D1Database, id: string, now: number, tz: string): Promise<Pending> {
  const r = await getPendingRow(db, id);
  if (!r) throw new Error("Ese pendiente no existe.");
  if (r.kind === "birthday" && r.birthday_md) {
    const tomorrow = toLocalIso(now + 86_400_000, tz).slice(0, 10);
    await db
      .prepare(`UPDATE pendings SET due_date = ?, nudge_count = 0, nudge_date = NULL, last_nudge_at = NULL WHERE id = ?`)
      .bind(nextBirthday(r.birthday_md, tomorrow), id)
      .run();
  } else {
    await db.prepare(`UPDATE pendings SET status = 'done', done_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  }
  // Los avisos que quedaran en cola para este pendiente ya no tienen sentido.
  await db
    .prepare(`UPDATE notifications SET status = 'cancelled' WHERE status = 'pending' AND dedupe_key LIKE ?`)
    .bind(`%:${id}:%`)
    .run();
  return (await getPending(db, id))!;
}

export async function reopenPending(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE pendings SET status = 'open', done_at = NULL WHERE id = ?`).bind(id).run();
}

export async function deletePending(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM pendings WHERE id = ?`).bind(id).run();
}

export async function snoozePending(db: D1Database, id: string, untilIso: string): Promise<void> {
  await db.prepare(`UPDATE pendings SET snoozed_until = ? WHERE id = ?`).bind(untilIso, id).run();
}

export async function recordNudge(db: D1Database, id: string, date: string, count: number, at: number): Promise<void> {
  await db
    .prepare(`UPDATE pendings SET nudge_date = ?, nudge_count = ?, last_nudge_at = ? WHERE id = ?`)
    .bind(date, count, new Date(at).toISOString(), id)
    .run();
}
