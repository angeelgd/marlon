import type { CalendarEvent, Settings } from "@marlon/shared";
import { formatEuros } from "@marlon/shared";
import type { CalendarService } from "../calendar/service";
import { addDays, localToMs, localToUtcIso, toLocalIso, toLocalParts, weekdayOf } from "../lib/time";
import { findFreeSlots } from "../schedule/slots";
import type { StoredRecipe } from "./recipes";

/**
 * Menú semanal y lista de la compra a partir de varias recetas de batch cooking,
 * ajustados al horario (táper los días de turno de tarde) y al presupuesto.
 */

export interface Meal {
  recipe: string;
  fromFreezer: boolean;
}

export interface MenuDay {
  date: string;
  lunch: Meal | null;
  dinner: Meal | null;
  note: string | null;
}

export interface ShoppingItem {
  name: string;
  quantity: number | null;
  unit: string | null;
  recipes: string[];
  checked?: boolean;
}

export interface ShoppingGroup {
  category: string;
  label: string;
  items: ShoppingItem[];
}

export const CATEGORY_ES: Record<string, string> = {
  produce: "Fruta y verdura",
  legumes: "Legumbres",
  grains: "Cereales y pasta",
  protein: "Tofu, tempeh y seitán",
  dairy_alt: "Bebidas y yogures vegetales",
  nuts_seeds: "Frutos secos y semillas",
  spices: "Especias y condimentos",
  canned: "Conservas",
  frozen: "Congelados",
  other: "Otros",
};

/** Último día de cocina (por defecto, el domingo) antes de que empiece la semana. */
export function cookingDateFor(weekStart: string, cookingWeekday: number): string {
  const back = (weekdayOf(weekStart) - cookingWeekday + 7) % 7 || 7;
  return addDays(weekStart, -back);
}

function overlapsDinner(e: CalendarEvent, date: string, tz: string): boolean {
  if (e.kind !== "work_planned") return false;
  const from = localToMs(`${date}T18:00`, tz);
  const to = localToMs(`${date}T21:00`, tz);
  return Date.parse(e.start) < to && Date.parse(e.end) > from;
}

export function buildMenu(recipes: StoredRecipe[], weekStart: string, events: CalendarEvent[], settings: Settings): {
  days: MenuDay[];
  cookDate: string;
  mealsCovered: number;
  servings: number;
} {
  const tz = settings.timezone;
  const cookDate = cookingDateFor(weekStart, settings.cookingWeekday);
  const left = recipes.map((r) => ({ title: r.recipe.title || r.title, servings: r.recipe.servings, keeps: r.recipe.storage_days ?? 4 }));
  const servings = left.reduce((a, r) => a + r.servings, 0);
  let previous = "";
  let covered = 0;

  const pick = (date: string): Meal | null => {
    const candidates = left.filter((r) => r.servings > 0).sort((a, b) => b.servings - a.servings);
    const r = candidates.find((c) => c.title !== previous) ?? candidates[0];
    if (!r) return null;
    r.servings--;
    previous = r.title;
    covered++;
    const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${cookDate}T00:00:00Z`)) / 86_400_000;
    return { recipe: r.title, fromFreezer: days > r.keeps };
  };

  const days: MenuDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const lunch = pick(date);
    const dinner = pick(date);
    const working = events.some((e) => overlapsDinner(e, date, tz));
    days.push({
      date,
      lunch,
      dinner,
      note: working && dinner ? "Turno de tarde: la cena va en táper al trabajo." : null,
    });
  }
  return { days, cookDate, mealsCovered: covered, servings };
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export function shoppingList(recipes: StoredRecipe[]): ShoppingGroup[] {
  const map = new Map<string, ShoppingItem & { category: string }>();
  for (const r of recipes) {
    const title = r.recipe.title || r.title;
    for (const ing of r.recipe.ingredients) {
      const key = `${norm(ing.name)}|${(ing.unit ?? "").toLowerCase()}`;
      const cur = map.get(key);
      if (cur) {
        cur.quantity = cur.quantity !== null && ing.quantity !== null ? Math.round((cur.quantity + ing.quantity) * 100) / 100 : (cur.quantity ?? ing.quantity);
        if (!cur.recipes.includes(title)) cur.recipes.push(title);
      } else {
        map.set(key, { name: ing.name, quantity: ing.quantity, unit: ing.unit, recipes: [title], category: ing.category });
      }
    }
  }
  const groups = new Map<string, ShoppingItem[]>();
  for (const { category, ...item } of map.values()) {
    const list = groups.get(category) ?? [];
    list.push(item);
    groups.set(category, list);
  }
  return Object.keys(CATEGORY_ES)
    .filter((c) => groups.has(c))
    .map((c) => ({
      category: c,
      label: CATEGORY_ES[c]!,
      items: groups.get(c)!.sort((a, b) => a.name.localeCompare(b.name, "es")),
    }));
}

export function nutritionCheck(recipes: StoredRecipe[], settings: Settings, mealsCovered: number) {
  const protein = recipes.reduce((a, r) => a + (r.recipe.protein_per_serving_g ?? 0) * r.recipe.servings, 0);
  const known = recipes.every((r) => r.recipe.protein_per_serving_g !== null);
  const perDay = Math.round(protein / 7);
  const target = settings.bodyWeightKg > 0 ? Math.round(settings.bodyWeightKg * settings.proteinPerKg) : null;
  const notes = [
    "B12: en una dieta vegana hace falta suplemento; ningún alimento del menú la cubre.",
    "Hierro: acompaña legumbres y tofu con algo de vitamina C (pimiento, cítricos) y evita el té o café con la comida.",
    "Omega 3: añade linaza o chía molida, o nueces; valora un suplemento de algas (DHA/EPA).",
    "Calcio: tofu cuajado con calcio y bebidas vegetales enriquecidas.",
    "Yodo: usa sal yodada.",
    "Vitamina D: en Finlandia, de octubre a marzo casi no hay sol; es habitual suplementar.",
  ];
  const warnings: string[] = [];
  if (recipes.some((r) => !r.recipe.vegan)) warnings.push("Alguna receta no parece vegana: revísala antes de cocinar.");
  if (target && known && perDay < target * 0.6) {
    warnings.push(
      `El batch cooking aporta unos ${perDay} g de proteína al día; tu objetivo ronda ${target} g. Completa con snacks (yogur de soja, edamame, cacahuetes) o una ración extra de legumbres.`,
    );
  }
  if (mealsCovered < 10) warnings.push(`Solo cubre ${mealsCovered} de las 14 comidas y cenas: añade otra receta o planifica el resto.`);
  return {
    protein_per_day_g: known ? perDay : null,
    protein_target_g: target,
    notes,
    warnings,
    disclaimer: "No soy nutricionista: son pautas generales. Para un plan a medida, consulta a un dietista-nutricionista.",
  };
}

export function budgetCheck(recipes: StoredRecipe[], settings: Settings) {
  const known = recipes.filter((r) => r.recipe.estimated_cost_eur !== null);
  const cents = Math.round(known.reduce((a, r) => a + (r.recipe.estimated_cost_eur ?? 0), 0) * 100);
  const budget = settings.foodWeeklyBudgetCents;
  return {
    estimated_cents: known.length ? cents : null,
    budget_cents: budget || null,
    message:
      !known.length || !budget
        ? null
        : cents <= budget
          ? `Coste estimado ${formatEuros(cents)}, dentro del presupuesto de ${formatEuros(budget)}.`
          : `Coste estimado ${formatEuros(cents)}, ${formatEuros(cents - budget)} por encima del presupuesto de ${formatEuros(budget)}.`,
  };
}

/**
 * Busca hueco para la sesión de cocina: el día preferido y, si no cabe, el anterior
 * o el lunes. Crea (o mueve) el evento "Batch cooking".
 */
export async function scheduleCooking(
  calendar: CalendarService,
  settings: Settings,
  weekStart: string,
  minutes: number,
  now: number,
): Promise<{ eventId: string; start: string; end: string } | { noSlot: string[] }> {
  const tz = settings.timezone;
  const cook = cookingDateFor(weekStart, settings.cookingWeekday);
  const candidates = [cook, addDays(cook, -1), weekStart];
  const duration = Math.max(90, Math.min(300, minutes));
  const busy = (
    await calendar.list(localToUtcIso(`${addDays(cook, -2)}T00:00`, tz), localToUtcIso(`${addDays(weekStart, 2)}T00:00`, tz))
  )
    .filter((e) => !e.allDay && e.marlonKey !== `cook:${weekStart}`)
    .map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) }));

  for (const date of candidates) {
    const slots = findFreeSlots({
      fromDate: date,
      toDate: date,
      durationMin: duration,
      dayStart: "10:00",
      dayEnd: "20:00",
      tz,
      busy,
      bufferMin: 15,
      notBefore: now,
    });
    const slot = slots[0];
    if (!slot) continue;
    const start = new Date(slot.start).toISOString();
    const end = new Date(slot.start + duration * 60_000).toISOString();
    const existing = await calendar.findByKey(`cook:${weekStart}`);
    const ev = existing
      ? await calendar.move(existing.id, start, end)
      : await calendar.create({
          title: "Batch cooking",
          start,
          end,
          kind: "marlon",
          marlonKey: `cook:${weekStart}`,
          description: "Cocinar el menú de la semana. La lista de la compra está en Marlon.",
        });
    return { eventId: ev.id, start: toLocalIso(Date.parse(ev.start), tz), end: toLocalIso(Date.parse(ev.end), tz) };
  }
  return { noSlot: candidates };
}

export async function saveMealPlan(
  db: D1Database,
  weekStart: string,
  plan: unknown,
  shopping: ShoppingGroup[],
  cookingEventId: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meal_plans (week_start, plan_json, shopping_json, cooking_event_id) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(week_start) DO UPDATE SET plan_json = ?2, shopping_json = ?3, cooking_event_id = ?4, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(weekStart, JSON.stringify(plan), JSON.stringify(shopping), cookingEventId)
    .run();
}

export async function getMealPlan(db: D1Database, weekStart?: string) {
  const row = weekStart
    ? await db.prepare(`SELECT * FROM meal_plans WHERE week_start = ?`).bind(weekStart).first<{ week_start: string; plan_json: string; shopping_json: string }>()
    : await db.prepare(`SELECT * FROM meal_plans ORDER BY week_start DESC LIMIT 1`).first<{ week_start: string; plan_json: string; shopping_json: string }>();
  if (!row) return null;
  return { weekStart: row.week_start, plan: JSON.parse(row.plan_json), shopping: JSON.parse(row.shopping_json) as ShoppingGroup[] };
}

export async function toggleShoppingItem(db: D1Database, weekStart: string, name: string, checked: boolean): Promise<boolean> {
  const plan = await getMealPlan(db, weekStart);
  if (!plan) return false;
  let found = false;
  for (const g of plan.shopping) for (const i of g.items) if (i.name === name) ((i.checked = checked), (found = true));
  if (found) await db.prepare(`UPDATE meal_plans SET shopping_json = ? WHERE week_start = ?`).bind(JSON.stringify(plan.shopping), weekStart).run();
  return found;
}

export const localDate = (ms: number, tz: string) => toLocalParts(ms, tz).date;
