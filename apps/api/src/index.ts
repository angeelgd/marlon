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
import { runCron } from "./cron";
import { z } from "zod";
import { closePending, deletePending, listPendings, reopenPending } from "./pendings/store";
import { ExpenseCategorySchema, PayRulesSchema } from "@marlon/shared";
import { addExpense, deleteBudgetItem, deleteExpense, expenseSummary, listBudgetItems, listExpenses, setBudgetItem } from "./money/expenses";
import { clearActualShift, currentMonth, deleteRuleSet, listRuleSets, logActualShift, monthPay, saveRuleSet } from "./money/payroll";
import { getMealPlan, toggleShoppingItem } from "./food/menu";
import { getRecipes } from "./food/recipes";
import type { SessionPhase } from "@marlon/shared";
import { activeSession, cancelSession, pauseSession, resumeSession, startSession } from "./wellbeing/sessions";
import { MEDITATIONS, pickMeditation, STRETCH_ROUTINES } from "./wellbeing/guided";
import { estimateFinish, listBooks, readingLogs, readingPace } from "./reading/books";
import { forget, listMemories, MEMORY_CATEGORIES, remember, updateMemory } from "./memory/store";
import { KNOWLEDGE } from "./knowledge";
import { dispatchNotifications, enqueue, vapidFromEnv } from "./push/scheduler";
import { toLocalIso } from "./lib/time";
import { mondayOfDate, replanGymWeek } from "./planning/apply";
import { fetchIcal, syncUniversity } from "./university/sync";
import { pushLocalEventsToGoogle } from "./calendar/migrate";
import { credentialSources, deleteCredential, saveCredential, withStoredCredentials, type StoredCredential } from "./integrations/credentials";
import { CALLBACK_PATH, finishGoogleAuth, redirectUri, startGoogleAuth } from "./integrations/google-oauth";
import { deleteUniversityIcalUrl, maskedHost, normalizeIcalUrl, saveUniversityIcalUrl, universityIcalUrl } from "./university/source";

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

// Credenciales guardadas desde Ajustes (cifradas): se añaden al entorno de la petición.
app.use("/api/*", async (c, next) => {
  if (c.req.path !== "/api/health") c.env = await withStoredCredentials(c.env);
  return next();
});

app.onError((err, c) => {
  console.error(err);
  if (err instanceof GoogleAuthError) return c.json({ error: err.message, code: "google_auth" }, 502);
  return c.json({ error: "Error interno." }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", authRoutes);

/** Vuelta del permiso de Google (sin cookie: la protege el state de un solo uso). */
app.get(CALLBACK_PATH, async (c) => {
  const origin = new URL(c.req.url).origin;
  try {
    await finishGoogleAuth(c.env, origin, new URL(c.req.url).searchParams);
    const env = await withStoredCredentials(c.env);
    const { calendar } = await calendarFor(env);
    const moved = await pushLocalEventsToGoogle(env.DB, calendar);
    await syncCalendar(env.DB, calendar).catch((err) => console.error("primera sincronización falló", err));
    return c.redirect(`/?connected=google&moved=${moved.moved}`, 302);
  } catch (err) {
    return c.redirect(`/?connect_error=${encodeURIComponent((err as Error).message)}`, 302);
  }
});

const api = new Hono<{ Bindings: Env }>();
api.use("*", requireAuth);

api.get("/messages", async (c) => c.json({ messages: await listUiMessages(c.env.DB) }));

api.post("/chat", async (c) => {
  const parsed = ChatRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Mensaje no válido." }, 400);
  if (!parsed.data.text.trim() && parsed.data.images.length === 0 && !parsed.data.audio) return c.json({ error: "Mensaje vacío." }, 400);
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

api.post("/university/sync", async (c) => {
  const { calendar, settings } = await calendarFor(c.env);
  try {
    const r = await syncUniversity(c.env, calendar, settings);
    if (r.skipped) return c.json({ error: "Aún no has añadido el enlace del calendario de la universidad." }, 400);
    return c.json(r);
  } catch (err) {
    if (err instanceof GoogleAuthError) throw err;
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** Estado de las conexiones externas. Nunca devuelve claves. */
api.get("/connections", async (c) => {
  const origin = new URL(c.req.url).origin;
  const src = await credentialSources(c.env);
  const { calendar } = await calendarFor(c.env);
  return c.json({
    google: {
      clientSource: src.GOOGLE_CLIENT_ID && src.GOOGLE_CLIENT_SECRET ? (src.GOOGLE_CLIENT_ID === "secret" ? "secret" : "app") : null,
      connected: calendar.backend.kind === "google",
      tokenSource: src.GOOGLE_REFRESH_TOKEN,
      redirectUri: redirectUri(origin),
    },
    youtube: { source: src.YOUTUBE_API_KEY },
    maps: { source: src.GOOGLE_MAPS_API_KEY },
  });
});

const ConnectionBody = z.object({
  clientId: z.string().trim().min(10).max(300).optional(),
  clientSecret: z.string().trim().min(6).max(300).optional(),
  key: z.string().trim().min(10).max(300).optional(),
});

api.put("/connections/:name", async (c) => {
  const name = c.req.param("name");
  const parsed = ConnectionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Datos no válidos." }, 400);
  const b = parsed.data;
  if (name === "google-client") {
    if (!b.clientId || !b.clientSecret) return c.json({ error: "Pega el ID y el secreto del cliente." }, 400);
    if (!b.clientId.endsWith(".apps.googleusercontent.com")) {
      return c.json({ error: "El ID del cliente termina en .apps.googleusercontent.com. Revisa que lo hayas copiado entero." }, 400);
    }
    await saveCredential(c.env, "GOOGLE_CLIENT_ID", b.clientId);
    await saveCredential(c.env, "GOOGLE_CLIENT_SECRET", b.clientSecret);
    return c.json({ ok: true });
  }
  if (name === "youtube" || name === "maps") {
    if (!b.key) return c.json({ error: "Pega la clave de API." }, 400);
    if (name === "youtube") {
      const check = await testYoutubeKey(b.key);
      if (check) return c.json({ error: check }, 400);
    }
    await saveCredential(c.env, name === "youtube" ? "YOUTUBE_API_KEY" : "GOOGLE_MAPS_API_KEY", b.key);
    return c.json({ ok: true });
  }
  return c.json({ error: "Conexión desconocida." }, 404);
});

api.delete("/connections/:name", async (c) => {
  const name = c.req.param("name");
  const keys: Record<string, StoredCredential[]> = {
    google: ["GOOGLE_REFRESH_TOKEN"],
    "google-client": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
    youtube: ["YOUTUBE_API_KEY"],
    maps: ["GOOGLE_MAPS_API_KEY"],
  };
  if (!keys[name]) return c.json({ error: "Conexión desconocida." }, 404);
  for (const k of keys[name]) await deleteCredential(c.env, k);
  return c.json({ ok: true });
});

/** Empieza el permiso de Google Calendar: la app navega aquí y se redirige a Google. */
api.get("/google/connect", async (c) => {
  try {
    return c.redirect(await startGoogleAuth(c.env, new URL(c.req.url).origin), 302);
  } catch (err) {
    return c.redirect(`/?connect_error=${encodeURIComponent((err as Error).message)}`, 302);
  }
});

/** Estado del enlace de la uni. Nunca devuelve la URL (su hash= es una contraseña). */
api.get("/university/link", async (c) => {
  const { url, source } = await universityIcalUrl(c.env);
  return c.json({ configured: Boolean(url), source, host: url ? maskedHost(url) : null });
});

/** Guarda el enlace (cifrado), comprueba que es un iCal y sincroniza. */
api.put("/university/link", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string });
  const { source } = await universityIcalUrl(c.env);
  if (source === "secret") {
    return c.json({ error: "El enlace está fijado como secreto en Cloudflare (UNIVERSITY_ICAL_URL). Cámbialo allí o bórralo para gestionarlo desde aquí." }, 409);
  }
  let url: string;
  try {
    url = normalizeIcalUrl(body.url ?? "");
    await fetchIcal(url);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  await saveUniversityIcalUrl(c.env, url);
  const { calendar, settings } = await calendarFor(c.env);
  const sync = await syncUniversity(c.env, calendar, settings, { url });
  return c.json({ configured: true, source: "app", host: maskedHost(url), sync, changeIds: calendar.changeIds });
});

api.delete("/university/link", async (c) => {
  await deleteUniversityIcalUrl(c.env);
  const { url, source } = await universityIcalUrl(c.env);
  return c.json({ configured: Boolean(url), source, host: url ? maskedHost(url) : null });
});

api.post("/gym/replan", async (c) => {
  const { calendar, settings } = await calendarFor(c.env);
  const today = toLocalIso(Date.now(), settings.timezone).slice(0, 10);
  const r = await replanGymWeek(calendar, settings, mondayOfDate(today), Date.now());
  return c.json({ ...r, changeIds: calendar.changeIds });
});

/* ---------------------------- push ---------------------------- */

const SubscriptionSchema = z.object({
  endpoint: z.string().url().startsWith("https://"),
  keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(32) }),
});

api.get("/push/key", (c) => {
  const vapid = vapidFromEnv(c.env);
  if (!vapid) return c.json({ error: "Faltan las claves VAPID en el servidor." }, 501);
  return c.json({ publicKey: vapid.publicKey });
});

api.post("/push/subscribe", async (c) => {
  const parsed = SubscriptionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Suscripción no válida." }, 400);
  const { endpoint, keys } = parsed.data;
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, user_agent = ?4, failures = 0`,
  )
    .bind(endpoint, keys.p256dh, keys.auth, c.req.header("user-agent")?.slice(0, 200) ?? null)
    .run();
  return c.json({ ok: true });
});

api.post("/push/unsubscribe", async (c) => {
  const body = await c.req.json<{ endpoint?: string }>().catch(() => ({}) as { endpoint?: string });
  if (body.endpoint) await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(body.endpoint).run();
  return c.json({ ok: true });
});

api.post("/push/test", async (c) => {
  const { settings } = await calendarFor(c.env);
  const now = Date.now();
  await enqueue(c.env.DB, {
    key: `test:${now}`,
    kind: "test",
    at: now,
    title: "Marlon",
    body: settings.textOnly ? "Las notificaciones funcionan (modo solo texto, sin sonido)." : "Las notificaciones funcionan.",
  });
  return c.json(await dispatchNotifications({ env: c.env, db: c.env.DB, settings, now }));
});

/* -------------------------- pendientes -------------------------- */

api.get("/pendings", async (c) => c.json({ pendings: await listPendings(c.env.DB, { includeDone: c.req.query("done") === "1" }) }));

api.post("/pendings/:id/close", async (c) => {
  const { settings } = await calendarFor(c.env);
  try {
    return c.json({ pending: await closePending(c.env.DB, c.req.param("id"), Date.now(), settings.timezone) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

api.post("/pendings/:id/reopen", async (c) => {
  await reopenPending(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

api.delete("/pendings/:id", async (c) => {
  await deletePending(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

/* ----------------------------- dinero ----------------------------- */
// Estas rutas no envían nada al modelo: son para ver y editar los datos en la app.

const MonthQuery = z.string().regex(/^\d{4}-\d{2}$/);

api.get("/money", async (c) => {
  const { settings } = await calendarFor(c.env);
  const month = MonthQuery.safeParse(c.req.query("month")).data ?? currentMonth(Date.now(), settings.timezone);
  const today = toLocalIso(Date.now(), settings.timezone).slice(0, 10);
  const pay = await monthPay(c.env.DB, month, settings);
  const summary = await expenseSummary(c.env.DB, month, settings, { today, payEstimateCents: pay.actualCents || null });
  // Comparación de texto: "YYYY-MM-31" cubre todos los días del mes.
  const expenses = await listExpenses(c.env.DB, `${month}-01`, `${month}-31`);
  return c.json({
    month,
    pay,
    summary,
    expenses,
    budget: await listBudgetItems(c.env.DB),
    ruleSets: await listRuleSets(c.env.DB),
    options: { eveMode: settings.payEveMode, midnightRule: settings.payMidnightRule },
  });
});

const ExpenseBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.number().int().positive().max(1_000_000),
  category: ExpenseCategorySchema,
  merchant: z.string().max(100).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

api.post("/expenses", async (c) => {
  const parsed = ExpenseBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Gasto no válido." }, 400);
  return c.json({ expense: await addExpense(c.env.DB, { ...parsed.data, source: "text" }) });
});

api.delete("/expenses/:id", async (c) => {
  return (await deleteExpense(c.env.DB, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "No existe." }, 404);
});

api.put("/budget", async (c) => {
  const parsed = z
    .object({ kind: z.enum(["income", "fixed"]), name: z.string().min(1).max(60), amountCents: z.number().int().positive(), bucket: z.enum(["needs", "wants", "savings"]).nullable().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Dato no válido." }, 400);
  return c.json({ item: await setBudgetItem(c.env.DB, { ...parsed.data, bucket: parsed.data.bucket ?? undefined }) });
});

api.delete("/budget/:id", async (c) => {
  await deleteBudgetItem(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

api.put("/actual-shifts/:date", async (c) => {
  const date = c.req.param("date");
  const parsed = z
    .object({ start: z.string().regex(/^\d{2}:\d{2}$/).optional(), end: z.string().regex(/^\d{2}:\d{2}$/).optional(), dayOff: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "Datos no válidos." }, 400);
  try {
    return c.json(await logActualShift(c.env.DB, { date, ...parsed.data }));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

api.delete("/actual-shifts/:date", async (c) => {
  await clearActualShift(c.env.DB, c.req.param("date"));
  return c.json({ ok: true });
});

api.put("/pay-rules", async (c) => {
  const parsed = z
    .object({
      id: z.string().optional(),
      validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      rules: PayRulesSchema,
      note: z.string().max(300).nullable(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Tabla no válida." }, 400);
  try {
    return c.json({ ruleSet: await saveRuleSet(c.env.DB, parsed.data) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

api.delete("/pay-rules/:id", async (c) => {
  const sets = await listRuleSets(c.env.DB);
  if (sets.length <= 1) return c.json({ error: "Tiene que quedar al menos una tabla." }, 400);
  await deleteRuleSet(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

/* ----------------------------- comida ----------------------------- */

api.get("/food", async (c) => c.json({ plan: await getMealPlan(c.env.DB, c.req.query("week") || undefined), recipes: await getRecipes(c.env.DB) }));

api.post("/food/shopping/toggle", async (c) => {
  const body = await c.req.json<{ week?: string; name?: string; checked?: boolean }>().catch(() => ({}) as { week?: string; name?: string; checked?: boolean });
  if (!body.week || !body.name) return c.json({ error: "Faltan datos." }, 400);
  const ok = await toggleShoppingItem(c.env.DB, body.week, body.name, Boolean(body.checked));
  return ok ? c.json({ ok: true }) : c.json({ error: "No existe." }, 404);
});

/* ---------------------- bienestar y lectura ---------------------- */

api.get("/session", async (c) => c.json({ session: await activeSession(c.env.DB, Date.now()) }));

api.post("/session/:id/:action", async (c) => {
  const { id, action } = c.req.param();
  try {
    if (action === "pause") return c.json({ session: await pauseSession(c.env, id, Date.now()) });
    if (action === "resume") return c.json({ session: await resumeSession(c.env, id, Date.now()) });
    if (action === "cancel") {
      await cancelSession(c.env, id);
      return c.json({ ok: true });
    }
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  return c.json({ error: "Acción no válida." }, 400);
});

api.post("/session/start", async (c) => {
  const body = await c.req.json<{ kind?: string; minutes?: number; routine?: string }>().catch(() => ({}) as { kind?: string; minutes?: number; routine?: string });
  const now = Date.now();
  if (body.kind === "meditation") {
    const m = pickMeditation(null, body.minutes);
    const med = MEDITATIONS[m];
    return c.json({ session: await startSession(c.env, { kind: "meditation", title: med.title, phases: med.phases }, now) });
  }
  if (body.kind === "stretch" && (body.routine === "post_gym" || body.routine === "desk")) {
    const r = STRETCH_ROUTINES[body.routine];
    return c.json({ session: await startSession(c.env, { kind: "stretch", title: r.title, phases: r.phases as unknown as SessionPhase[] }, now) });
  }
  return c.json({ error: "Sesión no válida." }, 400);
});

api.get("/reading", async (c) => {
  const { settings, calendar } = await calendarFor(c.env);
  const now = Date.now();
  const books = await listBooks(c.env.DB);
  const current = books.find((b) => b.status === "reading") ?? null;
  let estimate = null;
  if (current) {
    const pace = readingPace(await readingLogs(c.env.DB, current.id));
    const events = await calendar.list(new Date(now).toISOString(), new Date(now + 60 * 86_400_000).toISOString());
    estimate = { pacePerTrip: pace ? Math.round(pace * settings.defaultCommuteMin * 10) / 10 : null, ...estimateFinish({ percent: current.percent, pace, events, tz: settings.timezone, now, tripMinutes: settings.defaultCommuteMin }) };
  }
  return c.json({ current, estimate, books });
});

api.get("/memories", async (c) => c.json({ memories: await listMemories(c.env.DB) }));

api.post("/memories", async (c) => {
  const parsed = z.object({ content: z.string().min(3).max(500), category: z.enum(MEMORY_CATEGORIES).default("other") }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Recuerdo no válido." }, 400);
  return c.json(await remember(c.env.DB, parsed.data.content, parsed.data.category));
});

api.put("/memories/:id", async (c) => {
  const parsed = z.object({ content: z.string().min(3).max(500), category: z.enum(MEMORY_CATEGORIES).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Recuerdo no válido." }, 400);
  try {
    await updateMemory(c.env.DB, c.req.param("id"), parsed.data.content, parsed.data.category);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

api.delete("/memories/:id", async (c) => ((await forget(c.env.DB, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "No existe." }, 404)));

api.get("/knowledge", (c) => c.json({ docs: KNOWLEDGE.map((d) => ({ id: d.id, title: d.title, sources: d.sources })) }));

/* ------------------------ voz del proveedor ------------------------ */

api.post("/tts", async (c) => {
  const env = c.env;
  if (!env.TTS_BASE_URL || !env.TTS_API_KEY || !env.TTS_MODEL) {
    return c.json({ error: "No hay voz del proveedor configurada." }, 501);
  }
  const body = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
  const text = (body.text ?? "").slice(0, 2000);
  if (!text.trim()) return c.json({ error: "Texto vacío." }, 400);
  const res = await fetch(`${env.TTS_BASE_URL.replace(/\/+$/, "")}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.TTS_API_KEY}` },
    body: JSON.stringify({ model: env.TTS_MODEL, voice: env.TTS_VOICE || "alloy", input: text, response_format: "mp3" }),
  });
  if (!res.ok) return c.json({ error: `La voz del proveedor respondió ${res.status}.` }, 502);
  return new Response(res.body, { headers: { "content-type": res.headers.get("content-type") ?? "audio/mpeg", "cache-control": "no-store" } });
});

app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "No encontrado." }, 404));

export { NotificationScheduler } from "./push/alarm";

/** Devuelve un texto de error si la clave de YouTube no funciona. */
async function testYoutubeKey(key: string): Promise<string | null> {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=id&id=jNQXAC9IVRw&key=${encodeURIComponent(key)}`).catch(() => null);
  if (!res) return "No se pudo comprobar la clave con YouTube. Inténtalo de nuevo.";
  if (res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
  const reason = data.error?.errors?.[0]?.reason;
  if (reason === "accessNotConfigured" || /has not been used|disabled/i.test(data.error?.message ?? "")) {
    return "La clave es válida, pero falta activar YouTube Data API v3 en ese proyecto de Google Cloud.";
  }
  if (reason === "keyInvalid" || res.status === 400) return "Google dice que la clave no es válida.";
  return `YouTube respondió ${res.status}: ${data.error?.message ?? "sin detalle"}.`;
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      withStoredCredentials(env)
        .then((e) => runCron(event.cron, e))
        .catch((err) => console.error("cron falló", err)),
    );
  },
} satisfies ExportedHandler<Env>;
