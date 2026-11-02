import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { planNotifications } from "../src/push/scheduler";
import { localToUtcIso } from "../src/lib/time";
import { testCtx, testEnv, TZ } from "./helpers";

const at = (s: string) => Date.parse(localToUtcIso(s, TZ));
const req = (method: string, body?: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("avisos de la fase 4", () => {
  it("un mes antes de que caduque la tabla de sueldos", async () => {
    const env = testEnv();
    const ctx = testCtx(env);
    ctx.settings.morningBriefing = false;
    const base = { env, db: env.DB, calendar: ctx.calendar, settings: ctx.settings };
    expect(await planNotifications({ ...base, now: at("2027-05-30T12:00") })).toBe(0);
    expect(await planNotifications({ ...base, now: at("2027-05-31T12:00") })).toBe(1);
    expect(await planNotifications({ ...base, now: at("2027-06-01T12:00") })).toBe(0);
    const n = await env.DB.prepare(`SELECT body FROM notifications`).first<{ body: string }>();
    expect(n!.body).toContain("30/06/2027");
  });

  it("ideas de batch cooking el sábado (si se cocina el domingo y hay clave de YouTube)", async () => {
    const env = testEnv({ YOUTUBE_API_KEY: "yt" });
    const ctx = testCtx(env);
    ctx.settings.morningBriefing = false;
    const base = { env, db: env.DB, calendar: ctx.calendar, settings: ctx.settings };
    expect(await planNotifications({ ...base, now: at("2026-11-06T12:00") })).toBe(0); // viernes
    expect(await planNotifications({ ...base, now: at("2026-11-07T12:00") })).toBe(1); // sábado
    const n = await env.DB.prepare(`SELECT kind, url FROM notifications`).first<{ kind: string; url: string }>();
    expect(n!.kind).toBe("cooking");
    expect(decodeURIComponent(n!.url)).toContain("batch cooking");
  });
});

describe("rutas de dinero y comida", () => {
  const env = { ...testEnv(), DEV_AUTH_BYPASS: "1" };
  const base = "http://localhost:8787/api";

  it("gastos, sueldo, horas reales y tablas", async () => {
    expect((await app.request(`${base}/expenses`, req("POST", { date: "2026-11-02", amountCents: 450, category: "coffee" }), env)).status).toBe(200);
    expect((await app.request(`${base}/expenses`, req("POST", { date: "2026-11-02", amountCents: -1, category: "coffee" }), env)).status).toBe(400);
    expect((await app.request(`${base}/budget`, req("PUT", { kind: "income", name: "Sueldo", amountCents: 140000 }), env)).status).toBe(200);

    await env.DB.prepare(`INSERT INTO planned_shifts (date, start_time, end_time, ends_next_day, hours) VALUES ('2026-11-04', '15:45', '22:00', 0, 6.25)`).run();
    expect((await app.request(`${base}/actual-shifts/2026-11-04`, req("PUT", { end: "21:00" }), env)).status).toBe(200);

    const m = (await (await app.request(`${base}/money?month=2026-11`, {}, env)).json()) as {
      pay: { plannedCents: number; actualCents: number; differingDays: unknown[] };
      summary: { incomeCents: number };
      expenses: unknown[];
      ruleSets: { id: string }[];
    };
    expect(m.pay.plannedCents).toBe(9123);
    expect(m.pay.actualCents).toBe(Math.floor(((135 * 1370 + 180 * 1510) / 60) + 0.5));
    expect(m.pay.differingDays).toHaveLength(1);
    expect(m.summary.incomeCents).toBe(140000);
    expect(m.expenses).toHaveLength(1);

    // Editar la tabla: no se puede borrar la única, sí añadir otra.
    expect((await app.request(`${base}/pay-rules/${m.ruleSets[0]!.id}`, req("DELETE"), env)).status).toBe(400);
    const bad = await app.request(`${base}/pay-rules`, req("PUT", { validFrom: "2027-07-01", validTo: null, rules: { baseCents: -1 }, note: null }), env);
    expect(bad.status).toBe(400);
  });

  it("lista de la compra: tachar productos", async () => {
    await env.DB.prepare(`INSERT INTO meal_plans (week_start, plan_json, shopping_json) VALUES ('2026-11-09', '{}', ?)`)
      .bind(JSON.stringify([{ category: "legumes", label: "Legumbres", items: [{ name: "Garbanzos", quantity: 800, unit: "g", recipes: ["A"] }] }]))
      .run();
    expect((await app.request(`${base}/food/shopping/toggle`, req("POST", { week: "2026-11-09", name: "Garbanzos", checked: true }), env)).status).toBe(200);
    const f = (await (await app.request(`${base}/food`, {}, env)).json()) as { plan: { shopping: { items: { checked?: boolean }[] }[] } };
    expect(f.plan.shopping[0]!.items[0]!.checked).toBe(true);
  });
});
