import { nowIso } from "../lib/ids";
import type { EventInput } from "./backend";
import type { CalendarService } from "./service";

interface Row {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  location: string | null;
  description: string | null;
  kind: EventInput["kind"];
  marlon_key: string | null;
}

/**
 * Al conectar Google Calendar, los eventos que Marlon había creado en modo local
 * (turnos, clases, gimnasio...) se suben a Google y se cambia su id en todas partes,
 * para que el historial y el deshacer sigan funcionando.
 */
export async function pushLocalEventsToGoogle(db: D1Database, calendar: CalendarService, now = Date.now()) {
  if (calendar.backend.kind !== "google") return { moved: 0, failed: 0 };
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, title, start_at, end_at, location, description, kind, marlon_key FROM events_cache
       WHERE id LIKE 'local_%' AND deleted = 0 AND end_at >= ? ORDER BY start_at`,
    )
    .bind(since)
    .all<Row>();
  let moved = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i += 50) {
    const chunk = results.slice(i, i + 50);
    const out = await calendar.backend.batch(
      chunk.map((r) => ({
        op: "insert" as const,
        ev: { title: r.title, start: r.start_at, end: r.end_at, location: r.location, description: r.description, kind: r.kind, marlonKey: r.marlon_key },
      })),
    );
    const stmts: D1PreparedStatement[] = [];
    out.forEach((res, j) => {
      const old = chunk[j]!.id;
      if (!res.ok || !res.event) return void failed++;
      const id = res.event.id;
      moved++;
      stmts.push(
        db.prepare(`UPDATE events_cache SET id = ?, calendar_id = ?, etag = ?, updated_at = ? WHERE id = ?`).bind(id, calendar.calendarId, res.event.etag ?? null, nowIso(), old),
        db.prepare(`UPDATE change_log SET event_id = ? WHERE event_id = ?`).bind(id, old),
        db.prepare(`UPDATE planned_shifts SET event_id = ? WHERE event_id = ?`).bind(id, old),
        db.prepare(`UPDATE meal_plans SET cooking_event_id = ? WHERE cooking_event_id = ?`).bind(id, old),
      );
    });
    if (stmts.length) await db.batch(stmts);
  }
  // Lo local ya pasado se queda solo en el historial de Marlon.
  return { moved, failed };
}
