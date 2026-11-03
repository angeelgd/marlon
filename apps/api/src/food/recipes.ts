import { z } from "zod";
import type { Env } from "../env";
import type { LlmProvider } from "../llm/provider";
import type { VideoInfo } from "./youtube";

/**
 * Receta a partir de un vídeo de YouTube.
 * - Plan A: Gemini entiende el vídeo directamente (API nativa, file_data con la URL).
 * - Plan B: título y descripción del vídeo con el modelo de texto. La API oficial no
 *   permite descargar subtítulos de vídeos ajenos, así que la "transcripción" viable
 *   y legal es la descripción, donde muchos canales ponen la receta.
 */

export const IngredientCategorySchema = z.enum([
  "produce",
  "legumes",
  "grains",
  "protein",
  "dairy_alt",
  "nuts_seeds",
  "spices",
  "canned",
  "frozen",
  "other",
]);

export const RecipeSchema = z.object({
  title: z.string(),
  vegan: z.boolean().catch(true),
  servings: z.number().int().min(1).max(30).catch(4),
  prep_minutes: z.number().int().min(5).max(600).catch(60),
  ingredients: z
    .array(
      z.object({
        name: z.string(),
        quantity: z.number().nullable().catch(null),
        unit: z.string().nullable().catch(null),
        category: IngredientCategorySchema.catch("other"),
      }),
    )
    .catch([]),
  steps: z.array(z.string()).catch([]),
  protein_per_serving_g: z.number().nullable().catch(null),
  kcal_per_serving: z.number().nullable().catch(null),
  estimated_cost_eur: z.number().nullable().catch(null),
  storage_days: z.number().int().nullable().catch(null),
  highlights: z.string().catch(""),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export const RECIPE_PROMPT = [
  "Extract the batch-cooking recipe(s) shown in this video as ONE combined recipe for meal prep.",
  "Answer in Spanish. Use metric units (g, ml, unidades). Ingredient names in Spanish.",
  "Estimate protein and kcal per serving, the total cost in euros for Finland supermarkets, and how many days it keeps in the fridge.",
  "highlights: 2 sentences on what it brings for a vegan who wants to gain muscle (protein, iron, B12 sources, etc.).",
  "If it is not vegan, set vegan to false.",
  'JSON only: {"title": string, "vegan": boolean, "servings": number, "prep_minutes": number, "ingredients": [{"name": string, "quantity": number|null, "unit": string|null, "category": "produce"|"legumes"|"grains"|"protein"|"dairy_alt"|"nuts_seeds"|"spices"|"canned"|"frozen"|"other"}], "steps": [string], "protein_per_serving_g": number|null, "kcal_per_serving": number|null, "estimated_cost_eur": number|null, "storage_days": number|null, "highlights": string}',
].join("\n");

function parseRecipe(text: string): Recipe {
  return RecipeSchema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
}

/** Clave para la API nativa de Gemini (si el proveedor configurado es Gemini). */
export function geminiKey(env: Env): string | null {
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;
  if (env.LLM_API_KEY && (env.LLM_BASE_URL ?? "generativelanguage").includes("generativelanguage")) return env.LLM_API_KEY;
  return null;
}

export async function recipeFromVideo(env: Env, url: string, fetchImpl: typeof fetch = fetch): Promise<Recipe> {
  const key = geminiKey(env);
  if (!key) throw new Error("No hay clave de Gemini para entender vídeos.");
  const model = env.LLM_VIDEO_MODEL || env.LLM_MODEL || "gemini-2.5-flash";
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ file_data: { file_uri: url } }, { text: RECIPE_PROMPT }] }],
      generationConfig: { response_mime_type: "application/json", temperature: 0.2 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini respondió ${res.status} al ver el vídeo.`);
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini no devolvió la receta.");
  return parseRecipe(text);
}

export async function recipeFromDescription(llm: LlmProvider, video: Pick<VideoInfo, "title" | "description" | "channel">): Promise<Recipe> {
  const res = await llm.chat({
    json: true,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: `${RECIPE_PROMPT}\n\nNo puedes ver el vídeo: usa solo su título y descripción. Si la descripción no trae la receta, deduce una versión razonable a partir del título y dilo en highlights.\n\nTítulo: ${video.title}\nCanal: ${video.channel}\nDescripción:\n${video.description}`,
      },
    ],
  });
  return parseRecipe(res.content ?? "");
}

export interface StoredRecipe {
  videoId: string;
  url: string;
  title: string;
  channel: string | null;
  source: "video" | "description";
  recipe: Recipe;
}

export async function saveRecipe(db: D1Database, r: StoredRecipe): Promise<void> {
  await db
    .prepare(
      `INSERT INTO recipes (video_id, url, title, channel, source, recipe_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(video_id) DO UPDATE SET title = ?3, channel = ?4, source = ?5, recipe_json = ?6`,
    )
    .bind(r.videoId, r.url, r.title, r.channel, r.source, JSON.stringify(r.recipe))
    .run();
}

export async function getRecipes(db: D1Database, ids?: string[]): Promise<StoredRecipe[]> {
  const rows = ids?.length
    ? (
        await db
          .prepare(`SELECT * FROM recipes WHERE video_id IN (${ids.map(() => "?").join(",")})`)
          .bind(...ids)
          .all<{ video_id: string; url: string; title: string; channel: string | null; source: "video" | "description"; recipe_json: string }>()
      ).results
    : (
        await db
          .prepare(`SELECT * FROM recipes ORDER BY created_at DESC LIMIT 3`)
          .all<{ video_id: string; url: string; title: string; channel: string | null; source: "video" | "description"; recipe_json: string }>()
      ).results;
  return rows.map((r) => ({
    videoId: r.video_id,
    url: r.url,
    title: r.title,
    channel: r.channel,
    source: r.source,
    recipe: RecipeSchema.parse(JSON.parse(r.recipe_json)),
  }));
}
