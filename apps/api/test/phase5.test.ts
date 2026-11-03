import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "../src/agent/chat";
import { app } from "../src/index";
import { remember } from "../src/memory/store";
import { dispatchNotifications, enqueue } from "../src/push/scheduler";
import { generateKeyPair } from "../src/push/webpush";
import { testCtx, testEnv } from "./helpers";

const json = (method: string, body?: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("despacho sin duplicados", () => {
  it("dos despachos a la vez envían cada aviso una sola vez", async () => {
    const v = await generateKeyPair();
    const env = testEnv({ VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey });
    const ctx = testCtx(env);
    const dev = await generateKeyPair();
    await env.DB.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://push.example/x', ?, 'AAAAAAAAAAAAAAAAAAAAAA')`)
      .bind(dev.publicKey)
      .run();
    const now = Date.now();
    await enqueue(env.DB, { key: "timer:a:1", kind: "timer", at: now, title: "Descanso", body: "x" });
    let sends = 0;
    const fetchImpl = (async () => {
      sends++;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const deps = { env, db: env.DB, settings: ctx.settings, now, fetchImpl };
    const [a, b] = await Promise.all([dispatchNotifications(deps), dispatchNotifications(deps)]);
    expect(a.sent + b.sent).toBe(1);
    expect(sends).toBe(1);
  });
});

describe("chat de la fase 5 (proveedor de prueba)", () => {
  it("'30 minutos de estudio, 5 de descanso, 4 veces' abre el temporizador", async () => {
    const env = testEnv();
    const r = await handleChat(env, { text: "30 minutos de estudio, 5 minutos de descanso, 4 veces", images: [] }, Date.parse("2026-11-03T10:00:00Z"));
    expect(r.session?.kind).toBe("timer");
    expect(r.session?.phases).toHaveLength(7);
    expect(r.message.text).toContain("En marcha");
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'timer'`).first<{ n: number }>();
    expect(n!.n).toBe(7);
  });

  it("'voy por el 40 %' apunta la lectura", async () => {
    const env = testEnv();
    await handleChat(env, { text: "empiezo a leer «Sapiens»", images: [] }, Date.now());
    const r = await handleChat(env, { text: "voy por el 40 %", images: [] }, Date.now() + 1000);
    expect(r.message.text).toContain("40 % de «Sapiens»");
  });
});

describe("contexto: guía y memoria", () => {
  afterEach(() => vi.unstubAllGlobals());

  function capture() {
    const systems: string[] = [];
    vi.stubGlobal("fetch", (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      systems.push(body.messages[0].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch);
    return systems;
  }

  it("carga la guía relevante y la memoria, sin lo económico por la capa gratuita", async () => {
    const env = testEnv({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "k" });
    await remember(env.DB, "Le cuesta dormirse si toma café por la tarde", "health");
    await remember(env.DB, "Su alquiler son 550 euros", "other");
    const systems = capture();
    await handleChat(env, { text: "últimamente duermo fatal, ¿qué hago?", images: [] }, Date.now());
    expect(systems[0]).toContain('Guía de referencia relevante: "Sueño"');
    expect(systems[0]).toContain("(Fuente: Drake et al., 2013)");
    expect(systems[0]).toContain("Le cuesta dormirse si toma café por la tarde");
    expect(systems[0]).not.toContain("550");
  });

  it("sin tema conocido no carga ninguna guía", async () => {
    const env = testEnv({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "k" });
    const systems = capture();
    await handleChat(env, { text: "hola", images: [] }, Date.now());
    expect(systems[0]).not.toContain("Guía de referencia relevante");
  });
});

describe("rutas de la fase 5", () => {
  const env = { ...testEnv(), DEV_AUTH_BYPASS: "1" };
  const base = "http://localhost:8787/api";

  it("meditación desde la app: arrancar, pausar, reanudar y cancelar", async () => {
    const r = (await (await app.request(`${base}/session/start`, json("POST", { kind: "meditation", minutes: 3 }), env)).json()) as { session: { id: string; phases: unknown[] } };
    expect(r.session.phases).toHaveLength(4);
    const active = (await (await app.request(`${base}/session`, {}, env)).json()) as { session: { id: string } };
    expect(active.session.id).toBe(r.session.id);
    expect((await app.request(`${base}/session/${r.session.id}/pause`, json("POST", {}), env)).status).toBe(200);
    expect((await app.request(`${base}/session/${r.session.id}/resume`, json("POST", {}), env)).status).toBe(200);
    expect((await app.request(`${base}/session/${r.session.id}/cancel`, json("POST", {}), env)).status).toBe(200);
    expect(((await (await app.request(`${base}/session`, {}, env)).json()) as { session: unknown }).session).toBeNull();
    expect((await app.request(`${base}/session/start`, json("POST", { kind: "nope" }), env)).status).toBe(400);
  });

  it("memoria: ver, añadir, editar y borrar", async () => {
    const add = (await (await app.request(`${base}/memories`, json("POST", { content: "Le gusta la ciencia ficción", category: "reading" }), env)).json()) as { memory: { id: string } };
    expect((await app.request(`${base}/memories/${add.memory.id}`, json("PUT", { content: "Le encanta la ciencia ficción dura" }), env)).status).toBe(200);
    const list = (await (await app.request(`${base}/memories`, {}, env)).json()) as { memories: { content: string }[] };
    expect(list.memories.map((m) => m.content)).toContain("Le encanta la ciencia ficción dura");
    expect((await app.request(`${base}/memories/${add.memory.id}`, json("DELETE"), env)).status).toBe(200);
    expect((await app.request(`${base}/memories/${add.memory.id}`, json("DELETE"), env)).status).toBe(404);
  });

  it("lectura y guías", async () => {
    const r = (await (await app.request(`${base}/reading`, {}, env)).json()) as { current: unknown; books: unknown[] };
    expect(r.current).toBeNull();
    const k = (await (await app.request(`${base}/knowledge`, {}, env)).json()) as { docs: { id: string; sources: string[] }[] };
    expect(k.docs).toHaveLength(6);
  });
});
