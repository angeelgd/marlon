import { ChatRequestSchema, SettingsSchema } from "@marlon/shared";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { calendarFor, handleChat, listUiMessages } from "./agent/chat";
import { GoogleAuthError } from "./calendar/backend";
import { syncCalendar } from "./calendar/sync";
import { requireAuth } from "./auth/session";
import { authRoutes } from "./auth/webauthn";
import { saveSettings } from "./db/settings";
import type { Env } from "./env";
import { applyImport, buildPreview, discardUpload, loadUpload } from "./schedule/import";

export const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", secureHeaders());

// Defensa extra contra CSRF: las escrituras deben ser JSON (un formulario de otro sitio no puede enviarlo).
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const ct = c.req.header("content-type") ?? "";
    if (!ct.startsWith("application/json")) return c.json({ error: "Se esperaba JSON." }, 415);
  }
  return next();
});

app.onError((err, c) => {
  console.error(err);
  if (err instanceof GoogleAuthError) return c.json({ error: err.message, code: "google_auth" }, 502);
  return c.json({ error: "Error interno." }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", authRoutes);

const api = new Hono<{ Bindings: Env }>();
api.use("*", requireAuth);

api.get("/messages", async (c) => c.json({ messages: await listUiMessages(c.env.DB) }));

api.post("/chat", async (c) => {
  const parsed = ChatRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Mensaje no válido." }, 400);
  if (!parsed.data.text.trim() && parsed.data.images.length === 0) return c.json({ error: "Mensaje vacío." }, 400);
  return c.json(await handleChat(c.env, parsed.data));
});

api.get("/events", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return c.json({ error: "Parámetros from y to (ISO) obligatorios." }, 400);
  }
  const { calendar } = await calendarFor(c.env);
  return c.json({ events: await calendar.list(from, to), backend: calendar.backend.kind });
});

api.post("/sync", async (c) => {
  const { calendar } = await calendarFor(c.env);
  return c.json(await syncCalendar(c.env.DB, calendar));
});

api.get("/history", async (c) => {
  const { calendar } = await calendarFor(c.env);
  return c.json({ entries: await calendar.history(Number(c.req.query("limit") ?? 50)) });
});

api.post("/history/:id/undo", async (c) => {
  const { calendar } = await calendarFor(c.env);
  try {
    const undone = await calendar.undo(c.req.param("id"));
    return c.json({ undone });
  } catch (err) {
    if (err instanceof GoogleAuthError) throw err;
    return c.json({ error: (err as Error).message }, 400);
  }
});

api.get("/schedule/:id", async (c) => {
  const { settings, calendar } = await calendarFor(c.env);
  const up = await loadUpload(c.env.DB, c.req.param("id"));
  if (!up) return c.json({ error: "No existe." }, 404);
  return c.json(await buildPreview(calendar, c.req.param("id"), up.parsed, settings, up.status));
});

api.post("/schedule/:id/confirm", async (c) => {
  const { settings, calendar } = await calendarFor(c.env);
  try {
    const res = await applyImport(c.env.DB, calendar, c.req.param("id"), settings);
    return c.json({ ...res, changeIds: calendar.changeIds });
  } catch (err) {
    if (err instanceof GoogleAuthError) throw err;
    return c.json({ error: (err as Error).message }, 400);
  }
});

api.post("/schedule/:id/discard", async (c) => {
  await discardUpload(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

api.get("/settings", async (c) => {
  const { settings, calendar } = await calendarFor(c.env);
  return c.json({ settings, calendarBackend: calendar.backend.kind });
});

api.put("/settings", async (c) => {
  const parsed = SettingsSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Ajustes no válidos." }, 400);
  return c.json({ settings: await saveSettings(c.env.DB, parsed.data) });
});

app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "No encontrado." }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        // Limpieza de imágenes que no se llegaron a usar, sesiones y retos caducados.
        const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
        const now = new Date().toISOString();
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM pending_images WHERE created_at < ?`).bind(dayAgo),
          env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now),
          env.DB.prepare(`DELETE FROM auth_challenges WHERE expires_at < ?`).bind(now),
        ]);
        const { calendar } = await calendarFor(env);
        await syncCalendar(env.DB, calendar);
      })().catch((err) => console.error("cron falló", err)),
    );
  },
} satisfies ExportedHandler<Env>;
