import { DEFAULT_SETTINGS } from "@marlon/shared";
import { describe, expect, it } from "vitest";
import { executeTool } from "../src/agent/tools/types";
import { FOOD_TOOLS } from "../src/agent/tools/food";
import { budgetCheck, buildMenu, cookingDateFor, nutritionCheck, scheduleCooking, shoppingList } from "../src/food/menu";
import { recipeFromVideo, type Recipe, type StoredRecipe } from "../src/food/recipes";
import { isoDurationMinutes, videoIdFrom } from "../src/food/youtube";
import { localToUtcIso, toLocalIso } from "../src/lib/time";
import { fakeFetch, json } from "./fakes";
import { scripted, testCtx, testEnv, TZ } from "./helpers";

const recipe = (title: string, over: Partial<Recipe> = {}): StoredRecipe => ({
  videoId: title.slice(0, 11).padEnd(11, "x"),
  url: "https://www.youtube.com/watch?v=x",
  title,
  channel: "Canal",
  source: "video",
  recipe: {
    title,
    vegan: true,
    servings: 6,
    prep_minutes: 60,
    ingredients: [
      { name: "Garbanzos cocidos", quantity: 800, unit: "g", category: "legumes" },
      { name: "Cebolla", quantity: 2, unit: "unidades", category: "produce" },
    ],
    steps: ["Cocinar"],
    protein_per_serving_g: 25,
    kcal_per_serving: 550,
    estimated_cost_eur: 12,
    storage_days: 4,
    highlights: "Mucha proteína.",
    ...over,
  },
});

describe("utilidades de YouTube", () => {
  it("duraciones ISO y enlaces", () => {
    expect(isoDurationMinutes("PT14M30S")).toBe(15);
    expect(isoDurationMinutes("PT1H2M")).toBe(62);
    expect(videoIdFrom("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10")).toBe("dQw4w9WgXcQ");
    expect(videoIdFrom("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(videoIdFrom("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(videoIdFrom("hola")).toBeNull();
  });
});

describe("menú y lista de la compra", () => {
  it("cocina el domingo antes de la semana", () => {
    expect(cookingDateFor("2026-11-09", 0)).toBe("2026-11-08");
    expect(cookingDateFor("2026-11-09", 6)).toBe("2026-11-07");
  });

  it("reparte raciones alternando recetas, marca congelador y táper los días de turno", () => {
    const events = [
      { id: "w", title: "Trabajo", start: localToUtcIso("2026-11-10T15:45", TZ), end: localToUtcIso("2026-11-10T22:00", TZ), kind: "work_planned" as const },
    ];
    const m = buildMenu([recipe("Curry de garbanzos"), recipe("Chili de lentejas", { storage_days: 3 })], "2026-11-09", events, DEFAULT_SETTINGS);
    expect(m.servings).toBe(12);
    expect(m.mealsCovered).toBe(12);
    expect(m.days[0]!.lunch!.recipe).not.toBe(m.days[0]!.dinner!.recipe);
    expect(m.days[1]!.note).toContain("táper");
    // Cocinado el domingo 8: el jueves 12 (4 días) el chili (3 días) ya va del congelador.
    const thursday = m.days[3]!;
    const chili = [thursday.lunch, thursday.dinner].find((x) => x?.recipe === "Chili de lentejas");
    if (chili) expect(chili.fromFreezer).toBe(true);
    expect(m.days[6]!.lunch).toBeNull();
  });

  it("junta ingredientes iguales y agrupa por sección", () => {
    const list = shoppingList([recipe("A"), recipe("B", { ingredients: [{ name: "garbanzos cocidos", quantity: 400, unit: "g", category: "legumes" }] })]);
    expect(list.map((g) => g.label)).toEqual(["Fruta y verdura", "Legumbres"]);
    expect(list[1]!.items).toEqual([{ name: "Garbanzos cocidos", quantity: 1200, unit: "g", recipes: ["A", "B"] }]);
  });

  it("proteína, B12 y presupuesto", () => {
    const rs = [recipe("A"), recipe("B")];
    const n = nutritionCheck(rs, { ...DEFAULT_SETTINGS, bodyWeightKg: 75 }, 12);
    expect(n.protein_per_day_g).toBe(Math.round((25 * 12) / 7));
    expect(n.protein_target_g).toBe(120);
    expect(n.warnings.some((w) => w.includes("proteína"))).toBe(true);
    expect(n.notes[0]).toContain("B12");
    expect(n.disclaimer).toContain("nutricionista");
    expect(budgetCheck(rs, DEFAULT_SETTINGS).message!.replace(/ /g, " ")).toBe(
      "Coste estimado 24,00 €, dentro del presupuesto de 40,00 €.",
    );
  });

  it("reserva la sesión de cocina el domingo si hay hueco, y si no el sábado", async () => {
    const ctx = testCtx(testEnv(), Date.parse("2026-11-05T10:00:00Z"));
    const r = await scheduleCooking(ctx.calendar, ctx.settings, "2026-11-09", 120, ctx.now);
    expect(r).toMatchObject({ start: "2026-11-08T10:00", end: "2026-11-08T12:00" });

    const ctx2 = testCtx(testEnv(), Date.parse("2026-11-05T10:00:00Z"));
    await ctx2.calendar.create({ title: "Trabajo", start: localToUtcIso("2026-11-08T09:00", TZ), end: localToUtcIso("2026-11-08T21:00", TZ), kind: "work_planned" });
    const r2 = await scheduleCooking(ctx2.calendar, ctx2.settings, "2026-11-09", 120, ctx2.now);
    expect("start" in r2 && r2.start.slice(0, 10)).toBe("2026-11-07");
  });
});

describe("recetas desde vídeo", () => {
  it("plan A: manda la URL a la API nativa de Gemini", async () => {
    const { fn, calls } = fakeFetch([
      [/generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent/, () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(recipe("Tofu").recipe) }] } }] })],
    ]);
    const env = testEnv({ LLM_API_KEY: "g-key", LLM_MODEL: "gemini-x" });
    const r = await recipeFromVideo(env, "https://www.youtube.com/watch?v=abcdefghijk", fn);
    expect(r.title).toBe("Tofu");
    const body = JSON.parse(calls[0]!.body!);
    expect(body.contents[0].parts[0]).toEqual({ file_data: { file_uri: "https://www.youtube.com/watch?v=abcdefghijk" } });
    expect((calls[0]!.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
  });

  it("find_cooking_videos busca, analiza (plan B si falla el vídeo) y no repite", async () => {
    const env = testEnv({ YOUTUBE_API_KEY: "yt", LLM_API_KEY: "g-key" });
    const ctx = testCtx(env, Date.parse("2026-11-07T10:00:00Z"), scripted([() => ({ content: JSON.stringify(recipe("Lentejas").recipe), toolCalls: [] })]));
    const { fn, calls } = fakeFetch([
      [/youtube\/v3\/search/, () => json({ items: [{ id: { videoId: "aaaaaaaaaaa" } }] })],
      [
        /youtube\/v3\/videos/,
        () =>
          json({
            items: [
              { id: "aaaaaaaaaaa", snippet: { title: "Batch cooking vegano", channelTitle: "Canal", description: "Receta: lentejas..." }, contentDetails: { duration: "PT18M" }, statistics: { viewCount: "1000" } },
            ],
          }),
      ],
      [/generativelanguage/, () => new Response("quota", { status: 429 })],
    ]);
    ctx.fetchImpl = fn;
    const r = await executeTool(FOOD_TOOLS, "find_cooking_videos", JSON.stringify({ count: 1 }), ctx);
    expect(r.ok).toBe(true);
    const v = (r as { data: { videos: { understood_from: string; title: string }[] } }).data.videos;
    expect(v).toHaveLength(1);
    expect(v[0]!.understood_from).toContain("descripción");
    expect(calls.some((c) => c.url.includes("videoDuration=medium"))).toBe(true);

    const again = await executeTool(FOOD_TOOLS, "find_cooking_videos", JSON.stringify({ count: 1 }), ctx);
    expect((again as { data: { videos: unknown[] } }).data.videos).toEqual([]);
  });

  it("build_menu_and_shopping_list guarda el plan y crea la sesión de cocina", async () => {
    const env = testEnv();
    const ctx = testCtx(env, Date.parse("2026-11-05T10:00:00Z"));
    for (const r of [recipe("Curry"), recipe("Chili")]) {
      await env.DB.prepare(`INSERT INTO recipes (video_id, url, title, channel, source, recipe_json) VALUES (?, ?, ?, ?, 'video', ?)`)
        .bind(r.videoId, r.url, r.title, r.channel, JSON.stringify(r.recipe))
        .run();
    }
    const r = await executeTool(FOOD_TOOLS, "build_menu_and_shopping_list", "{}", ctx);
    expect(r.ok).toBe(true);
    const d = (r as { data: { week_start: string; cooking: { start: string } } }).data;
    expect(d.week_start).toBe("2026-11-09");
    expect(d.cooking.start).toBe("2026-11-08T10:00");
    const plan = await env.DB.prepare(`SELECT week_start FROM meal_plans`).first<{ week_start: string }>();
    expect(plan!.week_start).toBe("2026-11-09");
    const ev = await ctx.calendar.findByKey("cook:2026-11-09");
    expect(toLocalIso(Date.parse(ev!.start), TZ)).toBe("2026-11-08T10:00");
  });
});
