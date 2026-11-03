import { z } from "zod";
import { addDays, localToUtcIso, toLocalIso } from "../../lib/time";
import { budgetCheck, buildMenu, nutritionCheck, saveMealPlan, scheduleCooking, shoppingList } from "../../food/menu";
import { getRecipes, recipeFromDescription, recipeFromVideo, saveRecipe, type StoredRecipe } from "../../food/recipes";
import { markSuggested, pickFresh, searchCookingVideos, videoIdFrom } from "../../food/youtube";
import { mondayOfDate } from "../../planning/apply";
import { defineTool, ToolError, type Tool, type ToolContext } from "./types";

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");
const today = (ctx: ToolContext) => toLocalIso(ctx.now, ctx.settings.timezone).slice(0, 10);

/** Analiza un vídeo (o lo saca de la caché). Plan A: Gemini ve el vídeo. Plan B: descripción. */
async function analyze(ctx: ToolContext, urlOrId: string): Promise<StoredRecipe> {
  const id = videoIdFrom(urlOrId);
  if (!id) throw new ToolError("No reconozco ese enlace de YouTube.");
  const [cached] = await getRecipes(ctx.db, [id]);
  if (cached) return cached;
  const url = `https://www.youtube.com/watch?v=${id}`;

  let meta = { title: "", channel: "", description: "" };
  if (ctx.env.YOUTUBE_API_KEY) {
    const res = await (ctx.fetchImpl ?? fetch)(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${encodeURIComponent(ctx.env.YOUTUBE_API_KEY)}`,
    );
    if (res.ok) {
      const s = ((await res.json()) as { items?: { snippet?: { title?: string; channelTitle?: string; description?: string } }[] }).items?.[0]?.snippet;
      meta = { title: s?.title ?? "", channel: s?.channelTitle ?? "", description: s?.description ?? "" };
    }
  }

  let stored: StoredRecipe;
  try {
    const recipe = await recipeFromVideo(ctx.env, url, ctx.fetchImpl);
    stored = { videoId: id, url, title: meta.title || recipe.title, channel: meta.channel || null, source: "video", recipe };
  } catch (err) {
    if (!meta.title && !meta.description) {
      throw new ToolError(`No he podido ver el vídeo (${(err as Error).message}) ni leer su descripción.`);
    }
    const recipe = await recipeFromDescription(ctx.llm(), meta);
    stored = { videoId: id, url, title: meta.title, channel: meta.channel || null, source: "description", recipe };
  }
  await saveRecipe(ctx.db, stored);
  return stored;
}

const presentRecipe = (r: StoredRecipe) => ({
  video_id: r.videoId,
  url: r.url,
  title: r.title,
  channel: r.channel,
  understood_from: r.source === "video" ? "el vídeo" : "la descripción (no se pudo ver el vídeo)",
  servings: r.recipe.servings,
  prep_minutes: r.recipe.prep_minutes,
  protein_per_serving_g: r.recipe.protein_per_serving_g,
  kcal_per_serving: r.recipe.kcal_per_serving,
  estimated_cost_eur: r.recipe.estimated_cost_eur,
  keeps_days: r.recipe.storage_days,
  vegan: r.recipe.vegan,
  highlights: r.recipe.highlights,
  ingredients: r.recipe.ingredients.map((i) => `${i.quantity ?? ""} ${i.unit ?? ""} ${i.name}`.trim()),
});

export const findCookingVideos = defineTool({
  name: "find_cooking_videos",
  description:
    "Busca en YouTube vídeos de batch cooking vegano (alto en proteína) que no se hayan propuesto antes y resume lo que aporta cada uno.",
  schema: z.object({ query: z.string().max(100).optional(), count: z.number().int().min(1).max(3).default(2) }),
  async run(a, ctx) {
    if (!ctx.env.YOUTUBE_API_KEY) {
      throw new ToolError("No hay clave de YouTube configurada.", "Explica que puede añadir la clave de YouTube en Ajustes > Conexiones, o pasarte un enlace de un vídeo.");
    }
    const all = await searchCookingVideos({ db: ctx.db, apiKey: ctx.env.YOUTUBE_API_KEY, query: a.query, now: ctx.now, fetchImpl: ctx.fetchImpl });
    const fresh = await pickFresh(ctx.db, all, a.count);
    if (fresh.length === 0) return { videos: [], message: "No he encontrado vídeos nuevos esta semana." };
    const out = [];
    for (const v of fresh) {
      try {
        out.push(presentRecipe(await analyze(ctx, v.id)));
      } catch (err) {
        out.push({ url: v.url, title: v.title, channel: v.channel, minutes: v.minutes, error: (err as Error).message });
      }
    }
    await markSuggested(ctx.db, fresh.map((v) => v.id));
    ctx.out.quickReplies.push("Hazme el menú con estas", "Busca otras");
    return { videos: out };
  },
});

export const analyzeCookingVideo = defineTool({
  name: "analyze_cooking_video",
  description: "Entiende la receta de un vídeo de YouTube concreto (enlace que pasa el usuario) y la guarda para el menú.",
  schema: z.object({ url: z.string().min(5) }),
  async run(a, ctx) {
    return presentRecipe(await analyze(ctx, a.url));
  },
});

export const buildMenuAndShoppingList = defineTool({
  name: "build_menu_and_shopping_list",
  description:
    "Con varias recetas guardadas (por defecto, las últimas), arma el menú semanal y la lista de la compra, ajustados al horario (táper los días de turno de tarde) y al presupuesto, y reserva la sesión de cocina en el calendario (el domingo antes si hay hueco).",
  schema: z.object({
    video_ids: z.array(z.string()).max(4).optional(),
    week_start: LocalDate.optional().describe("Cualquier día de la semana del menú; por defecto, la semana que viene."),
    schedule_cooking: z.boolean().default(true),
  }),
  async run(a, ctx) {
    const recipes = await getRecipes(ctx.db, a.video_ids?.map((v) => videoIdFrom(v) ?? v));
    if (recipes.length === 0) throw new ToolError("No hay recetas guardadas.", "Primero usa find_cooking_videos o analyze_cooking_video.");
    const tz = ctx.settings.timezone;
    const weekStart = mondayOfDate(a.week_start ?? addDays(today(ctx), 7));
    const events = await ctx.calendar.list(localToUtcIso(`${weekStart}T00:00`, tz), localToUtcIso(`${addDays(weekStart, 7)}T00:00`, tz));
    const menu = buildMenu(recipes, weekStart, events, ctx.settings);
    const shopping = shoppingList(recipes);
    const nutrition = nutritionCheck(recipes, ctx.settings, menu.mealsCovered);
    const budget = budgetCheck(recipes, ctx.settings);
    const cooking = a.schedule_cooking
      ? await scheduleCooking(ctx.calendar, ctx.settings, weekStart, recipes.reduce((s, r) => s + r.recipe.prep_minutes, 0), ctx.now)
      : null;
    await saveMealPlan(
      ctx.db,
      weekStart,
      { ...menu, nutrition, budget, recipes: recipes.map((r) => ({ id: r.videoId, title: r.title, url: r.url })) },
      shopping,
      cooking && "eventId" in cooking ? cooking.eventId : null,
    );
    return {
      week_start: weekStart,
      cooking: cooking ? ("eventId" in cooking ? cooking : { no_slot_on: cooking.noSlot }) : undefined,
      menu: menu.days.map((d) => ({
        date: d.date,
        lunch: d.lunch ? `${d.lunch.recipe}${d.lunch.fromFreezer ? " (del congelador)" : ""}` : "libre",
        dinner: d.dinner ? `${d.dinner.recipe}${d.dinner.fromFreezer ? " (del congelador)" : ""}` : "libre",
        note: d.note ?? undefined,
      })),
      shopping_list: shopping.map((g) => ({
        section: g.label,
        items: g.items.map((i) => `${i.quantity ?? ""} ${i.unit ?? ""} ${i.name}`.trim()),
      })),
      budget: budget.message,
      nutrition,
      tip: "La lista completa queda en Más > Comida, con casillas para ir tachando.",
    };
  },
});

export const FOOD_TOOLS: Tool[] = [findCookingVideos, analyzeCookingVideo, buildMenuAndShoppingList] as Tool[];
