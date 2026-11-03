import { describe, expect, it } from "vitest";
import { handleChat } from "../src/agent/chat";
import { executeTool } from "../src/agent/tools/types";
import { PHASE1_TOOLS } from "../src/agent/tools";
import { applyImport, saveUpload } from "../src/schedule/import";
import { parseSchedule } from "../src/schedule/parse";
import { getLlm } from "../src/llm/router";
import { localToUtcIso, toLocalIso } from "../src/lib/time";
import { say, scripted, testCtx, testEnv, toolCall, TZ } from "./helpers";

const NOW = Date.parse("2026-11-01T10:00:00Z");
const IMG = { mime: "image/jpeg" as const, data: "AAAA" };

describe("importación del horario desde el chat (proveedor de prueba)", () => {
  it("lee la foto, guarda los turnos y permite deshacer todo de golpe", async () => {
    const env = testEnv();
    const res = await handleChat(env, { text: "este es mi horario de las próximas semanas", images: [IMG] }, NOW);

    expect(res.preview?.status).toBe("confirmed");
    expect(res.preview?.shifts.map((s) => s.date)).toEqual(["2026-11-02", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-08"]);
    expect(res.preview?.daysOff).toEqual(["2026-11-03", "2026-11-07"]);
    // 5 turnos y, como hay horario nuevo, el gimnasio de esa semana reajustado.
    const ctx0 = testCtx(env, NOW);
    const gyms = await ctx0.calendar.listByKeyPrefix("gym:");
    expect(gyms.length).toBeGreaterThanOrEqual(3);
    expect(res.changeIds).toHaveLength(5 + gyms.length);

    const ctx = testCtx(env, NOW);
    const events = (await ctx.calendar.list(localToUtcIso("2026-11-02T00:00", TZ), localToUtcIso("2026-11-09T00:00", TZ))).filter(
      (e) => e.kind === "work_planned",
    );
    expect(events.map((e) => `${toLocalIso(Date.parse(e.start), TZ)} ${toLocalIso(Date.parse(e.end), TZ)}`)).toEqual([
      "2026-11-02T15:45 2026-11-02T22:00",
      "2026-11-04T16:00 2026-11-04T22:00",
      "2026-11-05T15:45 2026-11-05T22:00",
      "2026-11-06T17:00 2026-11-06T23:30",
      "2026-11-08T12:45 2026-11-08T20:00",
    ]);
    expect(events.every((e) => e.kind === "work_planned")).toBe(true);

    const planned = await env.DB.prepare(`SELECT COUNT(*) AS n FROM planned_shifts`).first<{ n: number }>();
    expect(planned?.n).toBe(5);
    // La imagen no se queda guardada.
    const imgs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pending_images`).first<{ n: number }>();
    expect(imgs?.n).toBe(0);

    // Deshacer el grupo entero (turnos y gimnasio).
    await ctx.calendar.undo(res.changeIds[0]!);
    expect(await ctx.calendar.list(localToUtcIso("2026-11-02T00:00", TZ), localToUtcIso("2026-11-09T00:00", TZ))).toEqual([]);
  });
});

describe("applyImport", () => {
  it("una foto nueva sobrescribe solo los turnos planificados de esas fechas", async () => {
    const env = testEnv();
    const ctx = testCtx(env, NOW);
    const today = "2026-11-01";

    // Evento personal ese día: no se debe tocar.
    await ctx.calendar.create({
      title: "Clase",
      start: localToUtcIso("2026-11-02T09:00", TZ),
      end: localToUtcIso("2026-11-02T11:00", TZ),
      kind: "university",
    });

    const first = parseSchedule(
      [
        { date: "Nov-02", weekday: "Mon", start: "15.45", end: "22.00", hours: "6,25" },
        { date: "Nov-03", weekday: "Tue", start: "16.00", end: "22.00", hours: "6,00" },
        { date: "Nov-04", weekday: "Wed", start: "16.00", end: "22.00", hours: "6,00" },
      ],
      today,
    );
    const r1 = await applyImport(env.DB, ctx.calendar, await saveUpload(env.DB, [], first), ctx.settings);
    expect(r1).toMatchObject({ created: 3, changed: 0, removed: 0 });

    const second = parseSchedule(
      [
        { date: "Nov-02", weekday: "Mon", start: "15.45", end: "22.00", hours: "6,25" }, // igual
        { date: "Nov-03", weekday: "Tue", start: "", end: "", hours: "0,00" }, // ahora libre
        { date: "Nov-04", weekday: "Wed", start: "17.00", end: "23.00", hours: "6,00" }, // cambia
        { date: "Nov-05", weekday: "Thu", start: "15.00", end: "21.00", hours: "6,00" }, // nuevo
      ],
      today,
    );
    const r2 = await applyImport(env.DB, ctx.calendar, await saveUpload(env.DB, [], second), ctx.settings);
    expect(r2).toMatchObject({ created: 1, changed: 1, removed: 1, unchanged: 1 });

    const all = await ctx.calendar.list(localToUtcIso("2026-11-01T00:00", TZ), localToUtcIso("2026-11-10T00:00", TZ));
    expect(all.map((e) => `${e.title} ${toLocalIso(Date.parse(e.start), TZ)}`)).toEqual([
      "Clase 2026-11-02T09:00",
      "Trabajo 2026-11-02T15:45",
      "Trabajo 2026-11-04T17:00",
      "Trabajo 2026-11-05T15:00",
    ]);
    const shifts = await env.DB.prepare(`SELECT date FROM planned_shifts ORDER BY date`).all<{ date: string }>();
    expect(shifts.results.map((r) => r.date)).toEqual(["2026-11-02", "2026-11-04", "2026-11-05"]);
  });

  it("no guarda si quedan dudas, y con correcciones sí", async () => {
    const env = testEnv();
    const ctx = testCtx(env, NOW);
    const parsed = parseSchedule([{ date: "Nov-02", weekday: "Mon", start: "15.45", end: "22.00", hours: "7,00" }], "2026-11-01");
    expect(parsed.issues[0]!.kind).toBe("hours_mismatch");
    const id = await saveUpload(env.DB, [], parsed);
    await expect(applyImport(env.DB, ctx.calendar, id, ctx.settings)).rejects.toThrow("dudas");

    const r = await executeTool(
      PHASE1_TOOLS,
      "confirm_schedule_import",
      JSON.stringify({ upload_id: id, corrections: [{ date: "2026-11-02", start: "15:00", end: "22:00" }] }),
      ctx,
    );
    expect(r.ok).toBe(true);
    const ev = (await ctx.calendar.findByKey("work:2026-11-02"))!;
    expect(toLocalIso(Date.parse(ev.start), TZ)).toBe("2026-11-02T15:00");
  });
});

describe("parse_schedule_photo con dudas", () => {
  it("no guarda y ofrece botones cuando las horas no cuadran", async () => {
    const env = testEnv();
    const vision = scripted([
      () =>
        say(
          JSON.stringify({
            column_found: true,
            rows: [{ date: "Nov-02", weekday: "Mon", start: "15.45", end: "22.00", hours: "6,50" }],
          }),
        ),
    ]);
    const ctx = testCtx(env, NOW, vision);
    await env.DB.prepare(`INSERT INTO pending_images (id, mime, data) VALUES ('img1', 'image/jpeg', 'AAAA')`).run();
    ctx.imageIds = ["img1"];
    const r = await executeTool(PHASE1_TOOLS, "parse_schedule_photo", JSON.stringify({ image_index: 0 }), ctx);
    expect(r.ok).toBe(true);
    expect((r as { data: { saved: boolean } }).data.saved).toBe(false);
    expect(ctx.out.preview?.status).toBe("pending");
    expect(ctx.out.preview?.events[0]!.status).toBe("issue");
    expect(ctx.out.quickReplies).toContain("Guárdalo así");
    // La petición de visión lleva la imagen y pide JSON.
    expect(vision.calls[0]!.json).toBe(true);
    expect(JSON.stringify(vision.calls[0]!.messages)).toContain("data:image/jpeg;base64,AAAA");
  });

  it("pide permiso si la foto iría por la capa gratuita y está desactivado", async () => {
    const env = testEnv({ LLM_PROVIDER: "openai-compatible", LLM_API_KEY: "k" });
    const ctx = testCtx(env, NOW);
    ctx.llm = (opts) => getLlm(env, opts);
    ctx.settings.allowFreeTierForSchedulePhoto = false;
    await env.DB.prepare(`INSERT INTO pending_images (id, mime, data) VALUES ('img1', 'image/jpeg', 'AAAA')`).run();
    ctx.imageIds = ["img1"];
    const r = await executeTool(PHASE1_TOOLS, "parse_schedule_photo", JSON.stringify({ image_index: 0 }), ctx);
    expect(r).toMatchObject({ ok: true, data: { needs_consent: true } });
    expect(ctx.out.quickReplies.length).toBe(2);
  });
});

describe("toolCall helper", () => {
  it("existe", () => expect(toolCall("x", {}).toolCalls[0]!.function.name).toBe("x"));
});
