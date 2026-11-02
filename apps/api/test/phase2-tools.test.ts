import { afterEach, describe, expect, it, vi } from "vitest";
import { PHASE2_TOOLS } from "../src/agent/tools/planning";
import { executeTool } from "../src/agent/tools/types";
import { handleChat } from "../src/agent/chat";
import { runCron, UNIVERSITY_CRON } from "../src/cron";
import { replanGymWeek } from "../src/planning/apply";
import { localToUtcIso } from "../src/lib/time";
import { fakeFetch, json, openMeteo } from "./fakes";
import { testCtx, testEnv, TZ } from "./helpers";

const at = (s: string) => localToUtcIso(s, TZ);
const SUNDAY = Date.parse(at("2026-11-01T20:00"));

async function seedWeek(ctx: ReturnType<typeof testCtx>) {
  for (const [d, s, e] of [
    ["2026-11-02", "15:45", "22:00"],
    ["2026-11-04", "16:00", "22:00"],
    ["2026-11-05", "15:45", "22:00"],
    ["2026-11-06", "17:00", "23:30"],
    ["2026-11-08", "12:45", "20:00"],
  ] as const) {
    await ctx.calendar.create({ title: "Trabajo", start: at(`${d}T${s}`), end: at(`${d}T${e}`), kind: "work_planned", marlonKey: `work:${d}` });
  }
  await ctx.calendar.create({ title: "Clase", start: at("2026-11-03T08:15"), end: at("2026-11-03T10:00"), kind: "university" });
}

describe("replanGymWeek", () => {
  it("crea las sesiones, es idempotente y respeta duraciones y días saltados", async () => {
    const env = testEnv();
    const ctx = testCtx(env, SUNDAY);
    await seedWeek(ctx);

    const r1 = await replanGymWeek(ctx.calendar, ctx.settings, "2026-11-02", SUNDAY);
    expect(r1.created).toBeGreaterThanOrEqual(3);
    expect(r1.groupId).not.toBeNull();
    const gyms = await ctx.calendar.listByKeyPrefix("gym:");
    expect(gyms.every((g) => g.kind === "gym" && g.title === "Gimnasio")).toBe(true);

    const r2 = await replanGymWeek(ctx.calendar, ctx.settings, "2026-11-02", SUNDAY);
    expect(r2.created + r2.changed + r2.removed).toBe(0);
    expect(r2.groupId).toBeNull();

    const first = r1.sessions[0]!.start.slice(0, 10);
    const r3 = await replanGymWeek(ctx.calendar, ctx.settings, "2026-11-02", SUNDAY, { durations: { [first]: 90 } });
    const s3 = r3.sessions.find((s) => s.date === first)!;
    expect(s3.minutes).toBe(90);
    expect(r3.changed).toBe(1);

    const r4 = await replanGymWeek(ctx.calendar, ctx.settings, "2026-11-02", SUNDAY, { skipDates: [first] });
    expect(r4.sessions.some((s) => s.date === first)).toBe(false);
    expect(r4.removed + r4.changed + r4.created).toBeGreaterThan(0);
  });

  it("no toca sesiones pasadas", async () => {
    const env = testEnv();
    const ctx = testCtx(env, SUNDAY);
    await seedWeek(ctx);
    await replanGymWeek(ctx.calendar, ctx.settings, "2026-11-02", SUNDAY);
    const before = await ctx.calendar.listByKeyPrefix("gym:");
    const later = Date.parse(at("2026-11-05T23:00"));
    await replanGymWeek(ctx.calendar, ctx.settings, "2026-11-02", later);
    const after = await ctx.calendar.listByKeyPrefix("gym:");
    for (const g of before.filter((g) => Date.parse(g.start) < later)) {
      expect(after.find((a) => a.id === g.id)).toMatchObject({ start: g.start, end: g.end });
    }
  });
});

describe("herramientas de la fase 2", () => {
  it("plan_gym_week pregunta la duración cuando el hueco es justo", async () => {
    const env = testEnv();
    const ctx = testCtx(env, SUNDAY);
    // Toda la semana con huecos de 110 min por la mañana como mucho.
    for (const d of ["02", "03", "04", "05", "06", "07", "08"]) {
      await ctx.calendar.create({ title: "Clase", start: at(`2026-11-${d}T09:00`), end: at(`2026-11-${d}T10:00`), kind: "university" });
      await ctx.calendar.create({ title: "Trabajo", start: at(`2026-11-${d}T13:20`), end: at(`2026-11-${d}T22:00`), kind: "work_planned" });
    }
    const r = await executeTool(PHASE2_TOOLS, "plan_gym_week", JSON.stringify({ week_start: "2026-11-04" }), ctx);
    expect(r.ok).toBe(true);
    const data = (r as { data: { ask_duration_for?: { available_minutes: number }; sessions: string[] } }).data;
    expect(data.ask_duration_for?.available_minutes).toBe(110);
    expect(ctx.out.quickReplies).toEqual(["1h20", "1h35", "1h50"]);
  });

  it("get_sleep_plan calcula levantarse y acostarse", async () => {
    const env = testEnv();
    const ctx = testCtx(env, SUNDAY);
    await seedWeek(ctx);
    const r = await executeTool(PHASE2_TOOLS, "get_sleep_plan", JSON.stringify({ from_date: "2026-11-03", to_date: "2026-11-03" }), ctx);
    expect(r).toEqual({
      ok: true,
      data: { days: [{ date: "2026-11-03", wake: "07:00", bed_night_before: "2026-11-02T23:00", because_of: "Clase", ok: true }] },
    });
  });

  it("get_daily_briefing reúne tiempo, día, salida y sueño", async () => {
    const env = testEnv();
    const morning = Date.parse(at("2026-11-02T08:00"));
    const ctx = testCtx(env, morning);
    await seedWeek(ctx);
    ctx.fetchImpl = fakeFetch([[/open-meteo/, () => json(openMeteo("2026-11-02", { temp: 1, prob: 70, code: 71 }))]]).fn;
    const r = await executeTool(PHASE2_TOOLS, "get_daily_briefing", "{}", ctx);
    expect(r.ok).toBe(true);
    const d = (r as { data: Record<string, any> }).data; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.now).toBe("2026-11-02T08:00");
    expect(d.weekday).toBe("lunes");
    expect(d.weather.day).toMatchObject({ description: "nieve débil", max: 4, min: -2 });
    expect(d.events).toEqual([{ title: "Trabajo", kind: "work_planned", start: "15:45", end: "22:00" }]);
    expect(d.day_load.level).toBe("moderado");
    // Sin clave de Maps: estimación (15:45 menos 10 de margen y 30 de trayecto).
    expect(d.leave_for_next).toMatchObject({ title: "Trabajo", leaveAt: "2026-11-02T15:05", source: "estimate" });
    // Mañana clase a las 08:15: acostarse a las 23:00.
    expect(d.sleep).toMatchObject({ bed_tonight: "23:00", tonight_ok: true });
  });

  it("get_evening_review prepara el día siguiente", async () => {
    const env = testEnv();
    const ctx = testCtx(env, Date.parse(at("2026-11-02T22:40")));
    await seedWeek(ctx);
    ctx.fetchImpl = fakeFetch([[/open-meteo/, () => json(openMeteo("2026-11-02", { temp: 1, prob: 10 }))]]).fn;
    const r = await executeTool(PHASE2_TOOLS, "get_evening_review", "{}", ctx);
    const d = (r as { data: Record<string, any> }).data; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.tomorrow).toBe("2026-11-03");
    expect(d.sleep).toMatchObject({ bed_tonight: "2026-11-02T23:00", wake_tomorrow: "2026-11-03T07:00", ok: true });
    expect(d.first_departure_tomorrow).toMatchObject({ title: "Clase", leaveAt: "2026-11-03T07:35" });
  });

  it("import_university_calendar sin URL explica qué falta", async () => {
    const ctx = testCtx(testEnv(), SUNDAY);
    const r = await executeTool(PHASE2_TOOLS, "import_university_calendar", "{}", ctx);
    expect(r).toMatchObject({ ok: false, hint: expect.stringContaining("UNIVERSITY_ICAL_URL") });
  });

  it("get_route necesita evento o destino y hora", async () => {
    const ctx = testCtx(testEnv(), SUNDAY);
    const bad = await executeTool(PHASE2_TOOLS, "get_route", "{}", ctx);
    expect(bad.ok).toBe(false);
    const ok = await executeTool(PHASE2_TOOLS, "get_route", JSON.stringify({ destination: "Kauppatori", arrive_by: "2026-11-03T10:00" }), ctx);
    expect(ok).toMatchObject({ ok: true, data: { source: "estimate", leaveAt: "2026-11-03T09:30" } });
  });
});

describe("chat y cron", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("'buenos días' usa el resumen (proveedor de prueba)", async () => {
    const env = testEnv();
    vi.stubGlobal("fetch", fakeFetch([[/open-meteo/, () => json(openMeteo("2026-11-02", { temp: 1, prob: 10 }))]]).fn);
    const res = await handleChat(env, { text: "buenos días", images: [] }, Date.parse(at("2026-11-02T08:00")));
    expect(res.message.text).toContain("Buenos días Ángel. Son las 08:00");
  });

  it("el cron de la uni sincroniza y reajusta el gimnasio", async () => {
    const env = testEnv({ UNIVERSITY_ICAL_URL: "https://lukkari.example/x" });
    const now = Date.parse(at("2026-11-02T06:00"));
    const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART;TZID=Europe/Helsinki:20261103T081500\r\nDTEND;TZID=Europe/Helsinki:20261103T100000\r\nSUMMARY:Clase\r\nEND:VEVENT\r\nEND:VCALENDAR";
    vi.stubGlobal("fetch", fakeFetch([[/lukkari/, () => new Response(ics)]]).fn);
    await runCron(UNIVERSITY_CRON, env, now);
    const ctx = testCtx(env, now);
    expect(await ctx.calendar.listByKeyPrefix("uni:")).toHaveLength(1);
    const gyms = await ctx.calendar.listByKeyPrefix("gym:");
    expect(gyms.length).toBeGreaterThanOrEqual(3);
    // Ninguna sesión pisa la clase.
    const cls = (await ctx.calendar.listByKeyPrefix("uni:"))[0]!;
    expect(gyms.every((g) => g.end <= cls.start || g.start >= cls.end)).toBe(true);
  });
});
