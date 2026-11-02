import { createECDH } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error sin tipos
import ece from "http_ece";
import { handleChat } from "../src/agent/chat";
import { app } from "../src/index";
import { runCron } from "../src/cron";
import { localToUtcIso } from "../src/lib/time";
import { addPending, listPendings } from "../src/pendings/store";
import { dispatchNotifications, planNotifications } from "../src/push/scheduler";
import { b64urlDecode, b64urlEncode, generateKeyPair } from "../src/push/webpush";
import { fakeFetch, json, openMeteo } from "./fakes";
import { testCtx, testEnv, TZ } from "./helpers";

const at = (s: string) => Date.parse(localToUtcIso(s, TZ));

async function vapidEnv(extra = {}) {
  const v = await generateKeyPair();
  return testEnv({ VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: "mailto:yo@example.com", ...extra });
}

function device() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    ecdh,
    sub: {
      endpoint: "https://web.push.apple.com/abc",
      keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    },
  };
}

const decrypt = (body: Uint8Array, d: ReturnType<typeof device>) =>
  JSON.parse(
    ece
      .decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: d.ecdh, authSecret: Buffer.from(b64urlDecode(d.sub.keys.auth)) })
      .toString("utf8"),
  );

async function subscribe(env: ReturnType<typeof testEnv>, d: ReturnType<typeof device>) {
  await env.DB.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)`)
    .bind(d.sub.endpoint, d.sub.keys.p256dh, d.sub.keys.auth)
    .run();
}

describe("planificador de notificaciones", () => {
  it("buenos días a la hora de levantarse, sin duplicar", async () => {
    const env = await vapidEnv();
    const ctx = testCtx(env, at("2026-11-02T08:30"));
    await ctx.calendar.create({ title: "Trabajo", start: localToUtcIso("2026-11-02T15:45", TZ), end: localToUtcIso("2026-11-02T22:00", TZ), kind: "work_planned" });
    const deps = { env, db: env.DB, calendar: ctx.calendar, settings: ctx.settings, now: at("2026-11-02T08:30"), fetchImpl: fakeFetch([[/open-meteo/, () => json(openMeteo("2026-11-02", { temp: 1, prob: 50, code: 71 }))]]).fn };
    expect(await planNotifications(deps)).toBe(1);
    expect(await planNotifications(deps)).toBe(0);
    const n = await env.DB.prepare(`SELECT * FROM notifications`).first<{ kind: string; title: string; body: string; url: string }>();
    expect(n).toMatchObject({ kind: "morning", title: "Buenos días ☀️" });
    expect(n!.body).toBe("Hoy empiezas con Trabajo a las 15:45. 1 °C y nieve débil. Toca para ver tu día.");
    expect(decodeURIComponent(n!.url)).toBe("/?say=buenos días");
  });

  it("aviso de salida 10 min antes y repaso de la noche", async () => {
    const env = await vapidEnv();
    const ctx = testCtx(env);
    await ctx.calendar.create({ title: "Trabajo", start: localToUtcIso("2026-11-02T15:45", TZ), end: localToUtcIso("2026-11-02T22:00", TZ), kind: "work_planned" });
    await ctx.calendar.create({ title: "Clase", start: localToUtcIso("2026-11-03T08:15", TZ), end: localToUtcIso("2026-11-03T10:00", TZ), kind: "university" });
    const base = { env, db: env.DB, calendar: ctx.calendar, settings: ctx.settings };

    await planNotifications({ ...base, now: at("2026-11-02T14:50") });
    const leave = await env.DB.prepare(`SELECT * FROM notifications WHERE kind = 'leave'`).first<{ title: string; send_at: string; body: string }>();
    // Estimado: llegar 15:35, salir 15:05, avisar 14:55.
    expect(leave).toMatchObject({ title: "Sal a las 15:05", body: "Trabajo a las 15:45." });
    expect(leave!.send_at).toBe(new Date(at("2026-11-02T14:55")).toISOString());

    // Mañana clase 08:15 → acostarse 23:00 → repaso a las 22:15.
    await planNotifications({ ...base, now: at("2026-11-02T22:10") });
    const ev = await env.DB.prepare(`SELECT * FROM notifications WHERE kind = 'evening'`).first<{ body: string; send_at: string }>();
    expect(ev!.body).toBe("Para dormir 8 horas, a la cama a las 23:00. Toca para ver lo de mañana.");
    expect(ev!.send_at).toBe(new Date(at("2026-11-02T22:15")).toISOString());
  });

  it("insiste con los pendientes y registra cada aviso", async () => {
    const env = await vapidEnv();
    const ctx = testCtx(env);
    ctx.settings.morningBriefing = false;
    const p = await addPending(env.DB, { kind: "reminder", title: "Contestar a Mateo" }, at("2026-11-02T09:10"), TZ);
    const base = { env, db: env.DB, calendar: ctx.calendar, settings: ctx.settings };
    expect(await planNotifications({ ...base, now: at("2026-11-02T10:00") })).toBe(0);
    expect(await planNotifications({ ...base, now: at("2026-11-02T10:12") })).toBe(1);
    expect(await planNotifications({ ...base, now: at("2026-11-02T10:20") })).toBe(0);
    // Siguiente, 3 horas después del primero.
    expect(await planNotifications({ ...base, now: at("2026-11-02T13:13") })).toBe(1);
    const { results } = await env.DB.prepare(`SELECT dedupe_key, body FROM notifications ORDER BY send_at`).all<{ dedupe_key: string; body: string }>();
    expect(results.map((r) => r.dedupe_key)).toEqual([`nudge:${p.id}:2026-11-02:0`, `nudge:${p.id}:2026-11-02:1`]);
    expect(results[1]!.body).toBe("¿Pudiste contestar a Mateo? Si ya está, dímelo y lo quito.");
  });
});

describe("envío de notificaciones", () => {
  it("cifra para cada dispositivo, marca enviadas y respeta el modo solo texto", async () => {
    const env = await vapidEnv();
    const d = device();
    await subscribe(env, d);
    const ctx = testCtx(env);
    ctx.settings.textOnly = true;
    const now = at("2026-11-02T12:00");
    await env.DB.prepare(`INSERT INTO notifications (id, dedupe_key, kind, send_at, title, body, url) VALUES ('n1', 'nudge:p1:2026-11-02:0', 'nudge', ?, 'Recuerda', 'Contestar a Mateo.', '/')`)
      .bind(new Date(now - 60_000).toISOString())
      .run();
    const bodies: Uint8Array[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(init.body as Uint8Array);
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    expect(await dispatchNotifications({ env, db: env.DB, settings: ctx.settings, now, fetchImpl })).toEqual({ sent: 1, failed: 0 });
    expect(decrypt(bodies[0]!, d)).toEqual({ title: "Recuerda", body: "Contestar a Mateo.", url: "/", tag: "nudge:p1", silent: true });
    const st = await env.DB.prepare(`SELECT status FROM notifications WHERE id = 'n1'`).first<{ status: string }>();
    expect(st!.status).toBe("sent");
  });

  it("borra suscripciones caducadas y descarta avisos con mucho retraso", async () => {
    const env = await vapidEnv();
    await subscribe(env, device());
    const ctx = testCtx(env);
    const now = at("2026-11-02T12:00");
    await env.DB.prepare(`INSERT INTO notifications (id, dedupe_key, kind, send_at, title, body) VALUES ('old', 'a', 'nudge', ?, 't', 'b'), ('new', 'b', 'nudge', ?, 't', 'b')`)
      .bind(new Date(now - 3_600_000).toISOString(), new Date(now).toISOString())
      .run();
    const gone = (async () => new Response("", { status: 410 })) as unknown as typeof fetch;
    await dispatchNotifications({ env, db: env.DB, settings: ctx.settings, now, fetchImpl: gone });
    const { results } = await env.DB.prepare(`SELECT id, status FROM notifications ORDER BY id`).all<{ id: string; status: string }>();
    expect(results).toEqual([
      { id: "new", status: "pending" },
      { id: "old", status: "cancelled" },
    ]);
    const subs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>();
    expect(subs!.n).toBe(0);
  });

  it("sin claves VAPID no intenta enviar", async () => {
    const env = testEnv();
    const ctx = testCtx(env);
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO notifications (id, dedupe_key, kind, send_at, title, body) VALUES ('x', 'x', 'test', ?, 't', 'b')`).bind(new Date(now).toISOString()).run();
    expect(await dispatchNotifications({ env, db: env.DB, settings: ctx.settings, now })).toEqual({ sent: 0, failed: 1 });
  });
});

describe("voz y pendientes desde el chat (proveedor de prueba)", () => {
  it("una nota de voz se transcribe, crea el recordatorio y luego se cierra", async () => {
    const env = testEnv();
    const now = at("2026-11-02T09:00");
    const r1 = await handleChat(env, { text: "", images: [], audio: { mime: "audio/wav", data: "UklGRgAAAABXQVZF" } }, now);
    expect(r1.transcript).toBe("Recuérdame contestar a Mateo");
    expect(r1.message.text).toBe("Apuntado: Contestar a Mateo. Te lo iré recordando.");
    expect(r1.message.lang).toBe("es");
    const pend = await listPendings(env.DB);
    expect(pend.map((p) => [p.title, p.dueDate])).toEqual([["Contestar a Mateo", "2026-11-02"]]);

    const r2 = await handleChat(env, { text: "ya le contesté a Mateo", images: [] }, now + 3_600_000);
    expect(r2.message.text).toBe('¡Hecho! Quito "Contestar a Mateo" de la lista.');
    expect(await listPendings(env.DB)).toEqual([]);

    const ui = (await (await app.request("http://localhost:8787/api/messages", {}, { ...env, DEV_AUTH_BYPASS: "1" })).json()) as {
      messages: { text: string; fromVoice?: boolean }[];
    };
    expect(ui.messages[0]).toMatchObject({ text: "Recuérdame contestar a Mateo", fromVoice: true });
  });
});

describe("rutas de la fase 3", () => {
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  afterEach(() => vi.unstubAllGlobals());

  it("suscripción push: valida, guarda, prueba y da de baja", async () => {
    const env = { ...(await vapidEnv()), DEV_AUTH_BYPASS: "1" };
    const base = "http://localhost:8787/api";
    const key = (await (await app.request(`${base}/push/key`, {}, env)).json()) as { publicKey: string };
    expect(key.publicKey).toBe(env.VAPID_PUBLIC_KEY);
    expect((await app.request(`${base}/push/subscribe`, post({ endpoint: "http://inseguro" }), env)).status).toBe(400);
    const d = device();
    expect((await app.request(`${base}/push/subscribe`, post(d.sub), env)).status).toBe(200);

    const bodies: Uint8Array[] = [];
    vi.stubGlobal("fetch", (async (_u: string, init: RequestInit) => {
      bodies.push(init.body as Uint8Array);
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch);
    const test = (await (await app.request(`${base}/push/test`, post({}), env)).json()) as { sent: number };
    expect(test.sent).toBe(1);
    expect(decrypt(bodies[0]!, d).body).toBe("Las notificaciones funcionan 👌");

    await app.request(`${base}/push/unsubscribe`, post({ endpoint: d.sub.endpoint }), env);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("pendientes: listar, cerrar, reabrir y borrar", async () => {
    const env = { ...testEnv(), DEV_AUTH_BYPASS: "1" };
    const base = "http://localhost:8787/api";
    const p = await addPending(env.DB, { kind: "task", title: "Entregar la práctica", area: "uni", dueDate: "2026-11-10" }, Date.now(), TZ);
    const list = (await (await app.request(`${base}/pendings`, {}, env)).json()) as { pendings: { id: string }[] };
    expect(list.pendings.map((x) => x.id)).toEqual([p.id]);
    await app.request(`${base}/pendings/${p.id}/close`, post({}), env);
    expect(((await (await app.request(`${base}/pendings`, {}, env)).json()) as { pendings: unknown[] }).pendings).toEqual([]);
    await app.request(`${base}/pendings/${p.id}/reopen`, post({}), env);
    expect(((await (await app.request(`${base}/pendings`, {}, env)).json()) as { pendings: unknown[] }).pendings).toHaveLength(1);
    await app.request(`${base}/pendings/${p.id}`, { method: "DELETE", headers: { "content-type": "application/json" } }, env);
    expect(((await (await app.request(`${base}/pendings?done=1`, {}, env)).json()) as { pendings: unknown[] }).pendings).toEqual([]);
  });

  it("la voz del proveedor es opcional", async () => {
    const env = { ...testEnv(), DEV_AUTH_BYPASS: "1" };
    expect((await app.request("http://localhost:8787/api/tts", post({ text: "hola" }), env)).status).toBe(501);
  });

  it("el cron de 5 minutos planifica y envía", async () => {
    const env = await vapidEnv();
    const d = device();
    await subscribe(env, d);
    await addPending(env.DB, { kind: "reminder", title: "Llamar al banco" }, at("2026-11-02T09:00"), TZ);
    const sent: Uint8Array[] = [];
    vi.stubGlobal("fetch", (async (u: string, init: RequestInit) => {
      if (String(u).includes("open-meteo")) return json(openMeteo("2026-11-02", { temp: 1, prob: 1 }));
      sent.push(init.body as Uint8Array);
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch);
    await runCron("*/5 * * * *", env, at("2026-11-02T10:05"));
    // A esa hora tocan el buenos días (día libre: se levanta a las 08:30) y el primer aviso del pendiente.
    expect(sent.map((b) => decrypt(b, d).body).sort()).toEqual([
      "Hoy no tienes compromisos. 1 °C y casi despejado. Toca para ver tu día.",
      "Llamar al banco.",
    ]);
  });
});
