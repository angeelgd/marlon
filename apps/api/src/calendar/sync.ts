import { nowIso } from "../lib/ids";
import { SyncTokenExpiredError } from "./backend";
import type { CalendarService } from "./service";

/**
 * Sincronización incremental con Google Calendar usando syncToken.
 * Recoge también los cambios hechos a mano en el iPhone.
 */
export async function syncCalendar(
  db: D1Database,
  service: CalendarService,
): Promise<{ updated: number; skipped: boolean }> {
  if (service.backend.kind === "local") return { updated: 0, skipped: true };

  const state = await db
    .prepare(`SELECT sync_token FROM sync_state WHERE calendar_id = ?`)
    .bind(service.calendarId)
    .first<{ sync_token: string | null }>();

  // En la primera sincronización se trae desde hace 30 días.
  const timeMin = new Date(Date.now() - 30 * 86_400_000).toISOString();
  let page;
  try {
    page = await service.backend.listChanges(state?.sync_token ?? null, timeMin);
  } catch (err) {
    if (!(err instanceof SyncTokenExpiredError)) throw err;
    // Token caducado: sincronización completa.
    page = await service.backend.listChanges(null, timeMin);
  }

  for (const ev of page.events) {
    if (!ev.cancelled && (!ev.start || !ev.end)) continue;
    await service.upsertCache(ev);
  }

  await db
    .prepare(
      `INSERT INTO sync_state (calendar_id, sync_token, last_sync_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(calendar_id) DO UPDATE SET sync_token = ?2, last_sync_at = ?3`,
    )
    .bind(service.calendarId, page.nextSyncToken, nowIso())
    .run();

  return { updated: page.events.length, skipped: false };
}
