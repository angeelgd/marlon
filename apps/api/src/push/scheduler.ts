import type { CalendarEvent, Settings } from "@marlon/shared";
import type { CalendarService } from "../calendar/service";
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { addDays, localToMs, localToUtcIso, toLocalIso, toLocalParts, weekdayOf } from "../lib/time";
import { expiringRuleSet, listRuleSets } from "../money/payroll";
import { currentBook } from "../reading/books";
import { planDeparture } from "../integrations/routes";
import { getForecast, weatherAt } from "../integrations/weather";
import { birthdayNotices, nextNudge, type DayFrame } from "../pendings/nudges";
import { listPendingRows, recordNudge } from "../pendings/store";
import { planSleep, toCommitments, type Gym } from "../planning/sleep";
import { sendPush, type KeyPairB64 } from "./webpush";
import { pokeScheduler } from "./poke";

/**
 * Notificaciones programadas. El cron (cada 5 min) llama a planNotifications,
 * que mete en la cola lo que toca (sin duplicar gracias a dedupe_key), y a
 * dispatchNotifications, que envía lo vencido.
 */

export interface SchedulerDeps {
  env: Env;
  db: D1Database;
  calendar: CalendarService;
  settings: Settings;
  now: number;
  fetchImpl?: typeof fetch;
}

export interface QueuedNotification {
  key: string;
  kind: string;
  at: number;
  title: string;
  body: string;
  url?: string;
}

/** Próximo aviso pendiente (ms), para programar la alarma del Durable Object. */
export async function nextPendingAt(db: D1Database): Promise<number | null> {
  const r = await db
    .prepare(`SELECT MIN(send_at) AS at FROM notifications WHERE status = 'pending'`)
    .first<{ at: string | null }>();
  return r?.at ? Date.parse(r.at) : null;
}

export async function enqueue(db: D1Database, n: QueuedNotification): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO notifications (id, dedupe_key, kind, send_at, title, body, url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId("ntf"), n.key, n.kind, new Date(n.at).toISOString(), n.title, n.body, n.url ?? "/")
    .run();
  return (r.meta.changes ?? 0) > 0;
}

const hhmm = (ms: number, tz: string) => toLocalParts(ms, tz).time;
const COMMITMENTS: CalendarEvent["kind"][] = ["work_planned", "university", "gym", "marlon", "manual"];

/** Contexto del día: compromisos, hora de levantarse hoy y de acostarse esta noche. */
async function dayFrame(deps: SchedulerDeps) {
  const s = deps.settings;
  const tz = s.timezone;
  const today = toLocalIso(deps.now, tz).slice(0, 10);
  const events = await deps.calendar.list(
    localToUtcIso(`${addDays(today, -1)}T00:00`, tz),
    localToUtcIso(`${addDays(today, 2)}T00:00`, tz),
  );
  const gyms = new Map<string, Gym>();
  for (const e of events.filter((e) => e.kind === "gym")) {
    gyms.set(toLocalParts(Date.parse(e.start), tz).date, { start: Date.parse(e.start), end: Date.parse(e.end) });
  }
  const [sleepToday, sleepTomorrow] = planSleep([today, addDays(today, 1)], toCommitments(events), s, gyms);
  const todays = events.filter((e) => !e.allDay && toLocalParts(Date.parse(e.start), tz).date === today);
  const frame: DayFrame = {
    date: today,
    tz,
    wake: sleepToday!.wake,
    quietFrom: sleepTomorrow!.bedBefore - s.windDownMin * 60_000,
    busy: todays.filter((e) => COMMITMENTS.includes(e.kind)).map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) })),
  };
  return { today, events, todays, frame, bedTonight: sleepTomorrow!.bedBefore };
}

export async function planNotifications(deps: SchedulerDeps): Promise<number> {
  const { db, settings: s, now } = deps;
  const tz = s.timezone;
  const { today, todays, frame, bedTonight } = await dayFrame(deps);
  let queued = 0;
  const add = async (n: QueuedNotification) => {
    if (await enqueue(db, n)) queued++;
  };

  // 1. Buenos días, a la hora de levantarse (si no ha pasado hace mucho).
  if (s.morningBriefing && now >= frame.wake - 10 * 60_000 && now < frame.wake + 2 * 3600_000) {
    const first = todays.find((e) => COMMITMENTS.includes(e.kind) && Date.parse(e.start) > now);
    let weather = "";
    try {
      const f = await getForecast(db, s, deps.fetchImpl);
      const w = weatherAt(f, toLocalIso(now, tz));
      if (w) weather = ` ${Math.round(w.temperature)} °C y ${w.description}.`;
    } catch {
      /* sin tiempo no pasa nada */
    }
    const body = first
      ? `Hoy empiezas con ${first.title} a las ${hhmm(Date.parse(first.start), tz)}.${weather} Toca para ver tu día.`
      : `Hoy no tienes compromisos.${weather} Toca para ver tu día.`;
    await add({
      key: `morning:${today}`,
      kind: "morning",
      at: Math.max(frame.wake, now),
      title: "Buenos días ☀️",
      body,
      url: `/?say=${encodeURIComponent("buenos días")}`,
    });
  }

  // 2. Repaso de la noche, un rato antes de acostarse.
  if (s.eveningReview) {
    const at = bedTonight - s.eveningReviewLeadMin * 60_000;
    if (now >= at - 10 * 60_000 && now < bedTonight) {
      await add({
        key: `evening:${today}`,
        kind: "evening",
        at: Math.max(at, now),
        title: "Repaso de la noche 🌙",
        body: `Para dormir 8 horas, a la cama a las ${hhmm(bedTonight, tz)}. Toca para ver lo de mañana.`,
        url: `/?say=${encodeURIComponent("buenas noches")}`,
      });
    }
  }

  // 3. Hora de salida para los compromisos de las próximas 3 horas.
  if (s.leaveReminderMin > 0) {
    for (const e of todays) {
      const start = Date.parse(e.start);
      if (!COMMITMENTS.includes(e.kind) || start <= now || start > now + 3 * 3600_000) continue;
      const d = await planDeparture({ db, event: e, settings: s, mapsKey: deps.env.GOOGLE_MAPS_API_KEY, fetchImpl: deps.fetchImpl });
      const leaveAt = Date.parse(localToUtcIso(d.leaveAt, tz));
      const at = leaveAt - s.leaveReminderMin * 60_000;
      if (at < now - 5 * 60_000) continue;
      const how = d.source === "routes_api" ? ` Ruta: ${d.summary}.` : "";
      const bike = d.bike?.ok ? " Hoy la bici es buena opción." : "";
      await add({
        key: `leave:${e.id}:${e.start}`,
        kind: "leave",
        at: Math.max(at, now),
        title: `Sal a las ${d.leaveAt.slice(11)}`,
        body: `${e.title} a las ${hhmm(start, tz)}.${how}${bike}`,
        url: "/",
      });
    }
  }

  // Lectura: al acabar un trayecto en bus (llegada a un turno o clase, o vuelta a casa),
  // si no ha dicho por dónde va, se le pregunta.
  if (s.readingPrompts) {
    const book = await currentBook(db);
    if (book) {
      const lastLog = await db
        .prepare(`SELECT MAX(logged_at) AS at FROM reading_logs WHERE book_id = ?`)
        .bind(book.id)
        .first<{ at: string | null }>();
      const lastAt = lastLog?.at ? Date.parse(lastLog.at) : 0;
      const trip = s.defaultCommuteMin * 60_000;
      for (const e of todays.filter((x) => x.kind === "work_planned" || x.kind === "university")) {
        const arrive = Date.parse(e.start) - s.arrivalMarginMin * 60_000;
        const home = Date.parse(e.end) + trip;
        for (const [leg, at] of [["out", arrive], ["back", home]] as const) {
          if (now >= at && now < at + 20 * 60_000 && lastAt < at - trip - 15 * 60_000) {
            await add({
              key: `reading:${e.id}:${leg}`,
              kind: "reading",
              at: now,
              title: "📖 ¿Por dónde vas?",
              body: `Fin del trayecto. ¿Por dónde vas en «${book.title}»? Dímelo así: «voy por el 40 %».`,
              url: "/?tab=chat",
            });
          }
        }
      }
    }
  }

  // 4. Tabla de sueldos a punto de caducar (un mes antes) sin otra que la siga.
  const expiring = expiringRuleSet(await listRuleSets(db), today);
  if (expiring && now >= frame.wake + 60 * 60_000) {
    await add({
      key: `payrules:${expiring.id}`,
      kind: "payrules",
      at: now,
      title: "Toca actualizar el sueldo",
      body: `La tabla de sueldos vale hasta el ${expiring.validTo!.split("-").reverse().join("/")}. Cuando tengas la nueva, añádela en Más > Dinero.`,
      url: "/?tab=more",
    });
  }

  // 5. Ideas de batch cooking, el día antes del día de cocinar (sin gastar cuota hasta que las pida).
  if (deps.env.YOUTUBE_API_KEY && s.cookingVideosPerWeek > 0) {
    const dayBefore = (s.cookingWeekday + 6) % 7;
    const at = localToMs(`${today}T10:00`, tz);
    if (weekdayOf(today) === dayBefore && now >= at && now < at + 10 * 3600_000) {
      await add({
        key: `cooking:${today}`,
        kind: "cooking",
        at: now,
        title: "Ideas de batch cooking 🥦",
        body: `Te busco ${s.cookingVideosPerWeek === 1 ? "un vídeo" : "dos vídeos"} de batch cooking vegano para mañana. Toca y te los enseño.`,
        url: `/?say=${encodeURIComponent("Propónme vídeos de batch cooking para esta semana")}`,
      });
    }
  }

  // 6. Pendientes del día (insistencia gradual) y cumpleaños.
  for (const p of await listPendingRows(db)) {
    if (s.pendingNudges) {
      const n = nextNudge(p, frame, now);
      if (n && n.at <= now) {
        const ok = await enqueue(db, {
          key: `nudge:${p.id}:${today}:${n.index}`,
          kind: "nudge",
          at: now,
          title: n.title,
          body: n.body,
          url: "/?tab=pendings",
        });
        if (ok) {
          queued++;
          await recordNudge(db, p.id, today, n.index + 1, now);
        }
      }
    }
    for (const b of birthdayNotices(p, frame, s.birthdayNoticeDays)) {
      if (b.at <= now && now < b.at + 6 * 3600_000) {
        await add({ key: b.key, kind: "birthday", at: now, title: b.title, body: b.body, url: "/?tab=pendings" });
      }
    }
  }
  if (queued > 0) await pokeScheduler(deps.env);
  return queued;
}

export function vapidFromEnv(env: Env): (KeyPairB64 & { subject: string }) | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "mailto:marlon@example.invalid" };
}

interface NotificationRow {
  id: string;
  dedupe_key: string;
  kind: string;
  send_at: string;
  title: string;
  body: string;
  url: string | null;
  attempts: number;
}

/** Envía lo vencido a todas las suscripciones. Lo que lleva más de 30 min de retraso se descarta. */
export async function dispatchNotifications(deps: Omit<SchedulerDeps, "calendar">): Promise<{ sent: number; failed: number }> {
  const { db, now } = deps;
  const vapid = vapidFromEnv(deps.env);
  const nowIso = new Date(now).toISOString();
  await db
    .prepare(`UPDATE notifications SET status = 'cancelled', error = 'caducada' WHERE status = 'pending' AND send_at < ?`)
    .bind(new Date(now - 30 * 60_000).toISOString())
    .run();
  const { results: due } = await db
    .prepare(`SELECT * FROM notifications WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT 20`)
    .bind(nowIso)
    .all<NotificationRow>();
  if (due.length === 0) return { sent: 0, failed: 0 };

  const { results: subs } = await db
    .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions`)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  let sent = 0;
  let failed = 0;
  for (const n of due) {
    // Reserva atómica: el cron y el Durable Object pueden despachar a la vez,
    // pero solo uno consigue incrementar "attempts" desde el valor leído.
    const claim = await db
      .prepare(`UPDATE notifications SET attempts = attempts + 1 WHERE id = ? AND status = 'pending' AND attempts = ?`)
      .bind(n.id, n.attempts)
      .run();
    if ((claim.meta.changes ?? 0) !== 1) continue;
    if (!vapid || subs.length === 0) {
      await db.prepare(`UPDATE notifications SET status = 'failed', error = ? WHERE id = ?`)
        .bind(vapid ? "sin suscripciones" : "faltan las claves VAPID", n.id)
        .run();
      failed++;
      continue;
    }
    const payload = {
      title: n.title,
      body: n.body,
      url: n.url ?? "/",
      tag: n.dedupe_key.split(":").slice(0, 2).join(":"),
      // Modo solo texto: sin sonido ni vibración (donde el sistema lo respete).
      silent: deps.settings.textOnly,
    };
    let anyOk = false;
    let lastError = "";
    for (const sub of subs) {
      const r = await sendPush(sub, payload, vapid, {
        ttl: 30 * 60,
        urgency: n.kind === "leave" || n.kind === "timer" ? "high" : "normal",
        fetchImpl: deps.fetchImpl,
      });
      if (r.ok) {
        anyOk = true;
        await db.prepare(`UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE endpoint = ?`).bind(nowIso, sub.endpoint).run();
      } else if (r.gone) {
        await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(sub.endpoint).run();
        lastError = `suscripción caducada (${r.status})`;
      } else {
        await db.prepare(`UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?`).bind(sub.endpoint).run();
        lastError = `${r.status} ${r.error}`;
      }
    }
    if (anyOk) {
      await db.prepare(`UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?`).bind(nowIso, n.id).run();
      sent++;
    } else {
      const attempts = n.attempts + 1;
      await db
        .prepare(`UPDATE notifications SET status = ?, error = ? WHERE id = ?`)
        .bind(attempts >= 3 ? "failed" : "pending", lastError, n.id)
        .run();
      failed++;
    }
  }
  return { sent, failed };
}
