import { DEFAULT_SETTINGS } from "@marlon/shared";
import { describe, expect, it } from "vitest";
import { KNOWLEDGE, matchKnowledge, parseDoc } from "../src/knowledge";
import { listMemories, memoryPrompt, remember } from "../src/memory/store";
import { currentBook, estimateFinish, logReading, readingLogs, readingPace, startBook, tasteProfile, finishBook } from "../src/reading/books";
import { planNotifications } from "../src/push/scheduler";
import { localToUtcIso } from "../src/lib/time";
import { testCtx, testEnv, TZ } from "./helpers";

const at = (s: string) => Date.parse(localToUtcIso(s, TZ));

describe("lectura", () => {
  it("ritmo por trayecto y fecha estimada según los días con bus", async () => {
    const env = testEnv();
    const b = await startBook(env.DB, { title: "Proyecto Hail Mary", author: "Andy Weir", genre: "Ciencia ficción" }, at("2026-11-01T10:00"));
    await logReading(env.DB, b.id, 5, 30, at("2026-11-02T15:30"));
    await logReading(env.DB, b.id, 10, 30, at("2026-11-02T22:40"));
    await expect(logReading(env.DB, b.id, 4, 30, at("2026-11-03T08:00"))).rejects.toThrow("10 %");
    const pace = readingPace(await readingLogs(env.DB, b.id))!;
    expect(pace).toBeCloseTo(10 / 60);
    // Faltan 90 %: 540 min = 18 trayectos = 9 días con trabajo o clase.
    const ev = (d: string) => ({ id: d, title: "Trabajo", start: localToUtcIso(`${d}T15:45`, TZ), end: localToUtcIso(`${d}T22:00`, TZ), kind: "work_planned" as const });
    const days = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"];
    const est = estimateFinish({ percent: 10, pace, events: days.map(ev), tz: TZ, now: at("2026-11-03T08:00"), tripMinutes: 30 });
    expect(est).toEqual({ remainingMinutes: 540, remainingTrips: 18, finishDate: "2026-11-13" });
  });

  it("sin datos no inventa la fecha", () => {
    expect(estimateFinish({ percent: 0, pace: null, events: [], tz: TZ, now: 0, tripMinutes: 30 }).finishDate).toBeNull();
  });

  it("gustos: al principio propone géneros variados", async () => {
    const env = testEnv();
    const b = await startBook(env.DB, { title: "El marciano", genre: "Ciencia ficción" }, Date.now());
    await finishBook(env.DB, b.id, 5, "Me encantó lo de resolver problemas con ciencia.", Date.now());
    const t = await tasteProfile(env.DB);
    expect(t.phase).toBe("explore");
    expect(t.finished[0]).toMatchObject({ title: "El marciano", rating: 5 });
    expect(t.genres_to_try.some((g) => g.genre === "Ciencia ficción")).toBe(false);
    expect(t.genres_to_try.length).toBeGreaterThan(3);
    expect(await currentBook(env.DB)).toBeNull();
  });

  it("pregunta por el libro al acabar el trayecto si no lo ha actualizado", async () => {
    const env = testEnv();
    const ctx = testCtx(env);
    ctx.settings.morningBriefing = false;
    ctx.settings.leaveReminderMin = 0;
    await startBook(env.DB, { title: "Sapiens" }, at("2026-11-01T10:00"));
    await ctx.calendar.create({ title: "Trabajo", start: localToUtcIso("2026-11-03T15:45", TZ), end: localToUtcIso("2026-11-03T22:00", TZ), kind: "work_planned" });
    const base = { env, db: env.DB, calendar: ctx.calendar, settings: ctx.settings };
    expect(await planNotifications({ ...base, now: at("2026-11-03T15:20") })).toBe(0);
    expect(await planNotifications({ ...base, now: at("2026-11-03T15:40") })).toBe(1);
    const n = await env.DB.prepare(`SELECT title, body FROM notifications WHERE kind = 'reading'`).first<{ title: string; body: string }>();
    expect(n!.body).toContain("«Sapiens»");
    // Si ya lo ha dicho, no pregunta a la vuelta.
    const b = (await currentBook(env.DB))!;
    await logReading(env.DB, b.id, 20, 30, at("2026-11-03T22:31"));
    expect(await planNotifications({ ...base, now: at("2026-11-03T22:35") })).toBe(0);
  });
});

describe("memoria", () => {
  it("no duplica y marca como sensible lo económico", async () => {
    const env = testEnv();
    await remember(env.DB, "Prefiere entrenar antes de las 10 de la mañana", "preference");
    const r = await remember(env.DB, "Prefiere entrenar antes de las 10 de la mañana si puede", "preference");
    expect(r.updated).toBe(true);
    await remember(env.DB, "Su alquiler son 550 euros", "other");
    expect(await listMemories(env.DB)).toHaveLength(2);
    const free = await listMemories(env.DB, { includeSensitive: false });
    expect(free.map((m) => m.content)).toEqual(["Prefiere entrenar antes de las 10 de la mañana si puede"]);
    expect(memoryPrompt(free)).toContain("Gustos y preferencias:\n- Prefiere entrenar");
    await expect(remember(env.DB, "x")).rejects.toThrow();
  });
});

describe("base de conocimiento", () => {
  it("todas las guías tienen título, palabras clave, fuentes y citan en el texto", () => {
    expect(KNOWLEDGE.map((d) => d.id)).toEqual(["sueno", "entrenamiento", "nutricion-vegana", "productividad-estudio", "finanzas-personales", "bienestar-mente-cuerpo"]);
    for (const d of KNOWLEDGE) {
      expect(d.title.length, d.id).toBeGreaterThan(3);
      expect(d.keywords.length, d.id).toBeGreaterThan(5);
      expect(d.sources.length, d.id).toBeGreaterThan(1);
      expect(d.body, d.id).toContain("(Fuente:");
      expect(d.body, d.id).not.toMatch(/ — | – /);
    }
  });

  it("elige la guía por el mensaje", () => {
    expect(matchKnowledge("no consigo dormir bien, me despierto a las 4")[0]!.doc.id).toBe("sueno");
    expect(matchKnowledge("¿cuánta proteína necesito siendo vegano?")[0]!.doc.id).toBe("nutricion-vegana");
    expect(matchKnowledge("¿cuántas series hago para ganar músculo?")[0]!.doc.id).toBe("entrenamiento");
    expect(matchKnowledge("mañana tengo examen y no me concentro")[0]!.doc.id).toBe("productividad-estudio");
    expect(matchKnowledge("hola qué tal")).toEqual([]);
  });

  it("el parser de cabecera", () => {
    const d = parseDoc("x", "---\ntitle: Prueba\nkeywords: a, bb\nsources:\n- Uno\n- Dos\n---\n# Cuerpo\n");
    expect(d).toEqual({ id: "x", title: "Prueba", keywords: ["a", "bb"], sources: ["Uno", "Dos"], body: "# Cuerpo" });
    void DEFAULT_SETTINGS;
  });
});
