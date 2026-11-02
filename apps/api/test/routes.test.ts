import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { testEnv } from "./helpers";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("API", () => {
  it("health responde sin sesión", async () => {
    const res = await app.request("https://marlon.example/api/health", {}, testEnv());
    expect(res.status).toBe(200);
  });

  it("las rutas privadas exigen sesión", async () => {
    const env = testEnv();
    for (const path of ["/api/messages", "/api/events?from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z", "/api/history", "/api/settings"]) {
      const res = await app.request(`https://marlon.example${path}`, {}, env);
      expect(res.status, path).toBe(401);
    }
  });

  it("DEV_AUTH_BYPASS solo funciona en localhost", async () => {
    const env = testEnv({ DEV_AUTH_BYPASS: "1" });
    expect((await app.request("https://marlon.example/api/settings", {}, env)).status).toBe(401);
    expect((await app.request("http://localhost:8787/api/settings", {}, env)).status).toBe(200);
  });

  it("rechaza escrituras que no son JSON", async () => {
    const env = testEnv({ DEV_AUTH_BYPASS: "1" });
    const res = await app.request(
      "http://localhost:8787/api/chat",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "text=hola" },
      env,
    );
    expect(res.status).toBe(415);
  });

  it("el registro de passkey exige el código de configuración", async () => {
    const env = testEnv();
    const bad = await app.request("https://marlon.example/api/auth/register/options", json({ setupToken: "nope" }), env);
    expect(bad.status).toBe(403);
    const good = await app.request("https://marlon.example/api/auth/register/options", json({ setupToken: "setup-123" }), env);
    expect(good.status).toBe(200);
    const opts = (await good.json()) as { rp: { id: string }; challenge: string };
    expect(opts.rp.id).toBe("marlon.example");
    expect(good.headers.get("set-cookie")).toContain("marlon_challenge=");
  });

  it("estado de autenticación", async () => {
    const res = await app.request("https://marlon.example/api/auth/status", {}, testEnv());
    expect(await res.json()).toEqual({ authenticated: false, hasCredentials: false });
  });

  it("chat, eventos, ajustes e historial de punta a punta (modo local)", async () => {
    const env = testEnv({ DEV_AUTH_BYPASS: "1" });
    const base = "http://localhost:8787/api";

    const chat = await app.request(`${base}/chat`, json({ text: "hola" }), env);
    expect(chat.status).toBe(200);
    const body = (await chat.json()) as { message: { text: string } };
    expect(body.message.text).toContain("modo de prueba");

    const msgs = (await (await app.request(`${base}/messages`, {}, env)).json()) as { messages: unknown[] };
    expect(msgs.messages).toHaveLength(2);

    const put = await app.request(`${base}/settings`, { ...json({ scheduleColumnName: "Ángel" }), method: "PUT" }, env);
    expect(((await put.json()) as { settings: { scheduleColumnName: string } }).settings.scheduleColumnName).toBe("Ángel");

    const badPut = await app.request(`${base}/settings`, { ...json({ dayStart: "7am" }), method: "PUT" }, env);
    expect(badPut.status).toBe(400);

    const ev = await app.request(`${base}/events?from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z`, {}, env);
    expect(await ev.json()).toEqual({ events: [], backend: "local" });

    const undo = await app.request(`${base}/history/nope/undo`, json({}), env);
    expect(undo.status).toBe(400);
  });

  it("mensaje vacío da 400", async () => {
    const env = testEnv({ DEV_AUTH_BYPASS: "1" });
    const res = await app.request("http://localhost:8787/api/chat", json({ text: "  " }), env);
    expect(res.status).toBe(400);
  });
});
