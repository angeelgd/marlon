import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { calendarFor } from "../src/agent/chat";
import { pushLocalEventsToGoogle } from "../src/calendar/migrate";
import { CalendarService } from "../src/calendar/service";
import { LocalBackend, type BatchOp, type CalendarBackend } from "../src/calendar/backend";
import { credentialSources, saveCredential, withStoredCredentials } from "../src/integrations/credentials";
import { getSecure } from "../src/lib/vault";
import { testEnv } from "./helpers";

const base = "http://localhost:8787/api";
const jsonReq = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

afterEach(() => vi.unstubAllGlobals());

describe("credenciales desde Ajustes", () => {
  it("se guardan cifradas, completan el entorno y el secreto de Cloudflare manda", async () => {
    const env = testEnv();
    await saveCredential(env, "YOUTUBE_API_KEY", "yt-desde-la-app");
    const row = await env.DB.prepare(`SELECT ciphertext FROM secure_values WHERE key = 'cred:YOUTUBE_API_KEY'`).first<{ ciphertext: string }>();
    expect(row!.ciphertext).not.toContain("yt-desde");
    expect((await withStoredCredentials(env)).YOUTUBE_API_KEY).toBe("yt-desde-la-app");
    expect((await withStoredCredentials({ ...env, YOUTUBE_API_KEY: "secreto" })).YOUTUBE_API_KEY).toBe("secreto");

    const hydrated = await withStoredCredentials(env);
    expect((await credentialSources(hydrated)).YOUTUBE_API_KEY).toBe("app");
    expect((await credentialSources({ ...env, YOUTUBE_API_KEY: "secreto" })).YOUTUBE_API_KEY).toBe("secret");
    expect((await credentialSources(env)).GOOGLE_MAPS_API_KEY).toBeNull();
  });

  it("con el cliente y el refresh token guardados, el calendario pasa a Google", async () => {
    const env = testEnv();
    expect((await calendarFor(await withStoredCredentials(env))).calendar.backend.kind).toBe("local");
    await saveCredential(env, "GOOGLE_CLIENT_ID", "x.apps.googleusercontent.com");
    await saveCredential(env, "GOOGLE_CLIENT_SECRET", "s");
    await saveCredential(env, "GOOGLE_REFRESH_TOKEN", "r");
    expect((await calendarFor(await withStoredCredentials(env))).calendar.backend.kind).toBe("google");
  });

  it("rutas: valida el cliente OAuth, comprueba la clave de YouTube y nunca devuelve claves", async () => {
    const env = testEnv({ DEV_AUTH_BYPASS: "1" });
    const bad = await app.request(`${base}/connections/google-client`, jsonReq("PUT", { clientId: "1234567890abc", clientSecret: "secret12" }), env);
    expect(bad.status).toBe(400);
    const ok = await app.request(`${base}/connections/google-client`, jsonReq("PUT", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secreto" }), env);
    expect(ok.status).toBe(200);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { errors: [{ reason: "accessNotConfigured" }] } }), { status: 403 })));
    const yt = await app.request(`${base}/connections/youtube`, jsonReq("PUT", { key: "AIzaSy-clave-de-prueba" }), env);
    expect(((await yt.json()) as { error: string }).error).toMatch(/YouTube Data API v3/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect((await app.request(`${base}/connections/youtube`, jsonReq("PUT", { key: "AIzaSy-clave-de-prueba" }), env)).status).toBe(200);

    const status = await app.request(`${base}/connections`, {}, env);
    const text = await status.text();
    expect(text).not.toContain("GOCSPX");
    expect(text).not.toContain("AIzaSy");
    expect(JSON.parse(text)).toMatchObject({
      google: { clientSource: "app", connected: false, redirectUri: "http://localhost:8787/api/google/callback" },
      youtube: { source: "app" },
      maps: { source: null },
    });

    expect((await app.request(`${base}/connections/youtube`, jsonReq("DELETE"), env)).status).toBe(200);
    expect(((await (await app.request(`${base}/connections`, {}, env)).json()) as { youtube: { source: null } }).youtube.source).toBeNull();
  });

  it("flujo OAuth: redirige a Google con PKCE, y la vuelta exige el state y guarda el refresh token", async () => {
    const env = testEnv({ DEV_AUTH_BYPASS: "1" });
    await saveCredential(env, "GOOGLE_CLIENT_ID", "123-abc.apps.googleusercontent.com");
    await saveCredential(env, "GOOGLE_CLIENT_SECRET", "GOCSPX-x");
    const start = await app.request(`${base}/google/connect`, {}, env);
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(to.host).toBe("accounts.google.com");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("access_type")).toBe("offline");
    const state = to.searchParams.get("state")!;

    // State incorrecto: no se guarda nada.
    const wrong = await app.request(`${base}/google/callback?code=abc&state=otro`, {}, testEnv({ DB: env.DB }));
    expect(wrong.headers.get("location")).toMatch(/connect_error=/);
    expect(await getSecure(env, "cred:GOOGLE_REFRESH_TOKEN")).toBeNull();

    // Vuelve a empezar y completa con el state bueno (sin cookie de sesión).
    const again = new URL((await app.request(`${base}/google/connect`, {}, env)).headers.get("location")!);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ refresh_token: "1//refresco", access_token: "at", expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ items: [], nextSyncToken: "t1" }), { status: 200 });
      }),
    );
    const done = await app.request(`${base}/google/callback?code=abc&state=${again.searchParams.get("state")}`, {}, testEnv({ DB: env.DB }));
    expect(done.headers.get("location")).toMatch(/^\/\?connected=google/);
    expect(await getSecure(env, "cred:GOOGLE_REFRESH_TOKEN")).toBe("1//refresco");
    // El state es de un solo uso.
    const replay = await app.request(`${base}/google/callback?code=abc&state=${again.searchParams.get("state")}`, {}, testEnv({ DB: env.DB }));
    expect(replay.headers.get("location")).toMatch(/connect_error=/);
    expect(state).not.toBe(again.searchParams.get("state"));
  });
});

describe("paso de eventos locales a Google", () => {
  it("sube los eventos locales recientes y cambia su id en caché, historial y turnos", async () => {
    const env = testEnv();
    const now = Date.parse("2026-11-03T10:00:00Z");
    const local = new CalendarService(env.DB, new LocalBackend(), "Europe/Helsinki", "primary");
    const ev = await local.create({ title: "Trabajo", start: "2026-11-04T13:45:00Z", end: "2026-11-04T20:00:00Z", kind: "work_planned", marlonKey: "work:2026-11-04" });
    await env.DB.prepare(`INSERT INTO planned_shifts (date, start_time, end_time, hours, event_id) VALUES ('2026-11-04', '15:45', '22:00', 6.25, ?)`).bind(ev.id).run();

    const ops: BatchOp[] = [];
    const google: CalendarBackend = {
      kind: "google",
      async batch(o) {
        ops.push(...o);
        return o.map((_, i) => ({ ok: true as const, event: { id: `g${i}`, title: "", start: "", end: "", kind: "manual" as const } }));
      },
      insert: async () => { throw new Error(); },
      patch: async () => { throw new Error(); },
      remove: async () => {},
      listChanges: async () => ({ events: [], nextSyncToken: null }),
    };
    const r = await pushLocalEventsToGoogle(env.DB, new CalendarService(env.DB, google, "Europe/Helsinki", "primary"), now);
    expect(r).toEqual({ moved: 1, failed: 0 });
    expect(ops[0]).toMatchObject({ op: "insert", ev: { title: "Trabajo", marlonKey: "work:2026-11-04" } });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM events_cache WHERE id = 'g0'`).first("n")).toBe(1);
    expect(await env.DB.prepare(`SELECT event_id FROM planned_shifts WHERE date = '2026-11-04'`).first("event_id")).toBe("g0");
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_log WHERE event_id = 'g0'`).first("n")).toBe(1);
  });
});
