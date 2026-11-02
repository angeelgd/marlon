import { calendarFor } from "./agent/chat";
import { syncCalendar } from "./calendar/sync";
import type { Env } from "./env";
import { purgeExpiredCache } from "./integrations/cache";
import { addDays, toLocalIso } from "./lib/time";
import { mondayOfDate, replanGymWeek } from "./planning/apply";
import { syncUniversity } from "./university/sync";
import { dispatchNotifications, planNotifications } from "./push/scheduler";

// Debe coincidir con wrangler.toml [triggers].
export const UNIVERSITY_CRON = "7 */3 * * *";

/** Tareas programadas. Se exporta para poder probarla. */
export async function runCron(cron: string, env: Env, now = Date.now()): Promise<void> {
  const { calendar, settings } = await calendarFor(env);
  if (cron === UNIVERSITY_CRON) {
    // Calendario de la uni cada pocas horas. Si cambia algo, se reajusta el gimnasio.
    const r = await syncUniversity(env, calendar, settings, { now });
    if (!r.skipped && r.created + r.changed + r.removed > 0) {
      const today = toLocalIso(now, settings.timezone).slice(0, 10);
      for (const monday of [mondayOfDate(today), addDays(mondayOfDate(today), 7)]) {
        await replanGymWeek(calendar, settings, monday, now);
      }
    }
    return;
  }
  // Cada 5 minutos: limpieza, sincronización con Google Calendar y notificaciones.
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const nowIso = new Date(now).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM pending_images WHERE created_at < ?`).bind(dayAgo),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(nowIso),
    env.DB.prepare(`DELETE FROM auth_challenges WHERE expires_at < ?`).bind(nowIso),
  ]);
  await purgeExpiredCache(env.DB);
  try {
    await syncCalendar(env.DB, calendar);
  } catch (err) {
    console.error("sync con Google falló", err);
  }
  await planNotifications({ env, db: env.DB, calendar, settings, now });
  await dispatchNotifications({ env, db: env.DB, settings, now });
}
