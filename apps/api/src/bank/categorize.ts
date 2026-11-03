import { ExpenseCategorySchema, type ExpenseCategory } from "@marlon/shared";
import type { LlmProvider } from "../llm/provider";

/** Comercio normalizado para aprender categorías: sin números, referencias ni ruido. */
export function merchantKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const k = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\*/g, " ")
    .replace(/[^a-z\s&-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ");
  return k.length >= 2 ? k : null;
}

/** Reglas para los comercios habituales en Finlandia. El orden importa: lo más concreto primero. */
const RULES: [RegExp, ExpenseCategory][] = [
  [/spotify|netflix|disney|hbo|\bmax\b|viaplay|ruutu|youtube premium|apple\.com|icloud|google one|patreon|chatgpt|openai/, "subscriptions"],
  [/espresso house|robert'?s coffee|starbucks|kahvila|\bcafe\b|coffee|kahvi/, "coffee"],
  [/wolt|foodora|mcdonald|hesburger|burger king|subway|pizza|ravintola|kebab|sushi|unicafe|amica|sodexo|compass|juvenes|taco bell|max burgers/, "eating_out"],
  [/k-?market|k-?supermarket|k-?citymarket|citymarket|s-?market|prisma|alepa|\bsale\b|lidl|lahikauppa|m-?market|r-?kioski|ruokakauppa/, "groceries"],
  [/\bfoli\b|foli|\bhsl\b|\bvr\b|matkahuolto|onnibus|\buber\b|\bbolt\b|taksi|taxi|neste|\bst1\b|teboil|shell|\babc\b|kaupunkipyora|donkey|\btier\b|\bvoi\b|finnair|ryanair|norwegian/, "transport"],
  [/vuokra|\btys\b|ylioppilaskyla|\blumo\b|\bsato\b|kojamo|asunto/, "housing"],
  [/elisa|telia|\bdna\b|helen|fortum|turku energia|oomi|vattenfall|sahko|vesi|vakuutus|\bif\b vakuutus|lahitapiola|fennia|pohjola vakuutus/, "utilities"],
  [/apteekki|terveystalo|mehilainen|pihlajalinna|yths|fshs|hammas|optikko|instrumentarium|specsavers/, "health"],
  [/yliopisto|university|amk|akateeminen|suomalainen kirjakauppa|kurssi|course/, "education"],
  [/finnkino|elixia|fressi|liikunta|campusport|\bgym\b|kuntosali|steam|playstation|nintendo|xbox|lippu|ticketmaster|tiketti|bar\b|baari|pub\b|yokerho|club/, "leisure"],
  [/amazon|zalando|h&m|\bikea\b|tokmanni|clas ohlson|gigantti|verkkokauppa|power\b|stockmann|motonet|\bxxl\b|intersport|normal\b|flying tiger|lindex|kappahl|\bjysk\b|halonen|sokos|aliexpress|temu/, "shopping"],
];

export function ruleCategory(text: string): ExpenseCategory | null {
  const t = text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const [re, cat] of RULES) if (re.test(t)) return cat;
  return null;
}

/** Categorías aprendidas de las correcciones. */
export async function learnedCategories(db: D1Database, keys: string[]): Promise<Map<string, ExpenseCategory>> {
  const out = new Map<string, ExpenseCategory>();
  const uniq = [...new Set(keys)];
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT merchant_key, category FROM merchant_categories WHERE merchant_key IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ merchant_key: string; category: string }>();
    for (const r of results) {
      const c = ExpenseCategorySchema.safeParse(r.category);
      if (c.success) out.set(r.merchant_key, c.data);
    }
  }
  return out;
}

export async function learnCategory(db: D1Database, merchant: string | null, category: ExpenseCategory): Promise<string | null> {
  const key = merchantKey(merchant);
  if (!key) return null;
  await db
    .prepare(
      `INSERT INTO merchant_categories (merchant_key, category, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(merchant_key) DO UPDATE SET category = ?2, updated_at = ?3`,
    )
    .bind(key, category, new Date().toISOString())
    .run();
  return key;
}

/**
 * Los que no encajan en ninguna regla se le preguntan al modelo de una vez, con lo
 * mínimo: nombre del comercio, concepto corto e importe. Solo se llama con la clave de pago.
 */
export async function llmCategories(
  llm: LlmProvider,
  items: { merchant: string | null; description: string | null; cents: number }[],
): Promise<(ExpenseCategory | null)[]> {
  if (!items.length) return [];
  const cats = ExpenseCategorySchema.options.join(", ");
  const list = items.map((it, i) => ({ i, comercio: it.merchant ?? "", concepto: (it.description ?? "").slice(0, 60), euros: (it.cents / 100).toFixed(2) }));
  try {
    const r = await llm.chat({
      json: true,
      messages: [
        {
          role: "system",
          content: `Clasificas cargos bancarios de una persona que vive en Turku (Finlandia). Categorías válidas: ${cats}. Si no lo sabes, "other". Responde solo JSON: {"items":[{"i":0,"category":"groceries"}]}.`,
        },
        { role: "user", content: JSON.stringify(list) },
      ],
    });
    const parsed = JSON.parse(r.content ?? "{}") as { items?: { i?: number; category?: string }[] };
    const out: (ExpenseCategory | null)[] = items.map(() => null);
    for (const it of parsed.items ?? []) {
      const c = ExpenseCategorySchema.safeParse(it.category);
      if (typeof it.i === "number" && it.i >= 0 && it.i < out.length && c.success) out[it.i] = c.data;
    }
    return out;
  } catch {
    return items.map(() => null);
  }
}
