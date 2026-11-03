import { DurableObject } from "cloudflare:workers";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { withStoredCredentials } from "../integrations/credentials";
import { dispatchNotifications, nextPendingAt } from "./scheduler";

/**
 * Despachador preciso de notificaciones. El cron mira cada 5 minutos, que no
 * basta para un temporizador de 20 s de descanso. Este Durable Object pone una
 * alarma justo para el siguiente aviso pendiente, envía lo vencido y vuelve a
 * programarse. Si algo falla, el cron sigue enviando como respaldo.
 */
export class NotificationScheduler extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    await this.reschedule();
    return new Response("ok");
  }

  override async alarm(): Promise<void> {
    const settings = await getSettings(this.env.DB);
    const env = await withStoredCredentials(this.env);
    await dispatchNotifications({ env, db: env.DB, settings, now: Date.now() });
    await this.reschedule();
  }

  private async reschedule(): Promise<void> {
    const next = await nextPendingAt(this.env.DB);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 200));
  }
}
