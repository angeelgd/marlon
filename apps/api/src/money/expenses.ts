import {
  CATEGORY_LABELS,
  ExpenseCategorySchema,
  formatEuros,
  type BudgetItem,
  type Expense,
  type ExpenseCategory,
  type Settings,
} from "@marlon/shared";
import { z } from "zod";
import { newId } from "../lib/ids";
import { addDays } from "../lib/time";
import type { LlmProvider } from "../llm/provider";

/* ------------------------------------------------------------------ */
/* Gastos                                                              */
/* ------------------------------------------------------------------ */

interface ExpenseRow {
  id: string;
  date: string;
  amount_cents: number;
  merchant: string | null;
  category: string;
  note: string | null;
  source: Expense["source"];
  created_at: string;
}

const toExpense = (r: ExpenseRow): Expense => ({
  id: r.id,
  date: r.date,
  amountCents: r.amount_cents,
  merchant: r.merchant,
  category: ExpenseCategorySchema.catch("other").parse(r.category),
  note: r.note,
  source: r.source,
  createdAt: r.created_at,
});

export async function addExpense(
  db: D1Database,
  e: { date: string; amountCents: number; merchant?: string | null; category: ExpenseCategory; note?: string | null; source: Expense["source"] },
): Promise<Expense> {
  if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) throw new Error("El importe tiene que ser mayor que cero.");
  if (e.amountCents > 1_000_000) throw new Error("Ese importe parece demasiado alto. ¿Lo revisas?");
  const id = newId("exp");
  await db
    .prepare(`INSERT INTO expenses (id, date, amount_cents, merchant, category, note, source) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, e.date, e.amountCents, e.merchant ?? null, e.category, e.note ?? null, e.source)
    .run();
  return toExpense((await db.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(id).first<ExpenseRow>())!);
}

export async function deleteExpense(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare(`DELETE FROM expenses WHERE id = ?`).bind(id).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function listExpenses(db: D1Database, from: string, to: string): Promise<Expense[]> {
  const { results } = await db
    .prepare(`SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date DESC, created_at DESC`)
    .bind(from, to)
    .all<ExpenseRow>();
  return results.map(toExpense);
}

/** "4,50" | "4.50" | "1.234,56" | "12" → céntimos. */
export function parseAmount(raw: string | number): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  let s = raw.replace(/[€\s]|eur(os)?/gi, "").trim();
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/* ------------------------------------------------------------------ */
/* Sueldo, alquiler y gastos fijos                                     */
/* ------------------------------------------------------------------ */

interface BudgetRow {
  id: string;
  kind: BudgetItem["kind"];
  name: string;
  amount_cents: number;
  bucket: BudgetItem["bucket"];
}

export async function listBudgetItems(db: D1Database): Promise<BudgetItem[]> {
  const { results } = await db.prepare(`SELECT * FROM budget_items ORDER BY kind DESC, name`).all<BudgetRow>();
  return results.map((r) => ({ id: r.id, kind: r.kind, name: r.name, amountCents: r.amount_cents, bucket: r.bucket }));
}

/** Crea o actualiza (por nombre) un ingreso o gasto fijo mensual. */
export async function setBudgetItem(
  db: D1Database,
  item: { kind: BudgetItem["kind"]; name: string; amountCents: number; bucket?: BudgetItem["bucket"] },
): Promise<BudgetItem> {
  const existing = await db
    .prepare(`SELECT id FROM budget_items WHERE kind = ? AND lower(name) = lower(?)`)
    .bind(item.kind, item.name.trim())
    .first<{ id: string }>();
  const id = existing?.id ?? newId("bud");
  const bucket = item.kind === "income" ? null : (item.bucket ?? "needs");
  await db
    .prepare(
      `INSERT INTO budget_items (id, kind, name, amount_cents, bucket) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET amount_cents = ?4, bucket = ?5, name = ?3`,
    )
    .bind(id, item.kind, item.name.trim(), item.amountCents, bucket)
    .run();
  return { id, kind: item.kind, name: item.name.trim(), amountCents: item.amountCents, bucket };
}

export async function deleteBudgetItem(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM budget_items WHERE id = ?`).bind(id).run();
}

/* ------------------------------------------------------------------ */
/* Resumen con la regla 50/30/20                                        */
/* ------------------------------------------------------------------ */

/** Necesidades y deseos según la regla 50/30/20 (necesidades 50 %, deseos 30 %, ahorro 20 %). */
export const NEEDS: ExpenseCategory[] = ["groceries", "transport", "housing", "utilities", "health", "education"];

export interface ExpenseSummary {
  month: string;
  incomeCents: number;
  incomeSource: "budget" | "pay_estimate" | "none";
  fixedCents: number;
  variableCents: number;
  byCategory: { category: ExpenseCategory; cents: number; count: number; previousCents: number }[];
  rule503020: {
    needsCents: number;
    wantsCents: number;
    needsPct: number | null;
    wantsPct: number | null;
    savingsTargetCents: number;
    /** Proyección de lo que quedará a fin de mes al ritmo actual. */
    projectedLeftCents: number;
    /** Cuánto apartar este mes (objetivo del 20 %, o lo que se pueda si no llega). */
    suggestedSavingsCents: number;
  };
  alerts: string[];
  comparisons: string[];
  disclaimer: string;
}

export async function expenseSummary(
  db: D1Database,
  month: string,
  settings: Settings,
  opts: { today: string; payEstimateCents?: number | null },
): Promise<ExpenseSummary> {
  const from = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y! + 1}-01-01` : `${y}-${String(m! + 1).padStart(2, "0")}-01`;
  const to = addDays(next, -1);
  const prevFrom = m === 1 ? `${y! - 1}-12-01` : `${y}-${String(m! - 1).padStart(2, "0")}-01`;
  const prevTo = addDays(from, -1);

  const [expenses, previous, budget] = await Promise.all([
    listExpenses(db, from, to),
    listExpenses(db, prevFrom, prevTo),
    listBudgetItems(db),
  ]);

  const budgetIncome = budget.filter((b) => b.kind === "income").reduce((a, b) => a + b.amountCents, 0);
  const incomeCents = budgetIncome || opts.payEstimateCents || 0;
  const incomeSource: ExpenseSummary["incomeSource"] = budgetIncome ? "budget" : opts.payEstimateCents ? "pay_estimate" : "none";
  const fixed = budget.filter((b) => b.kind === "fixed");
  const fixedCents = fixed.reduce((a, b) => a + b.amountCents, 0);

  const cats = new Map<ExpenseCategory, { cents: number; count: number }>();
  for (const e of expenses) {
    const c = cats.get(e.category) ?? { cents: 0, count: 0 };
    c.cents += e.amountCents;
    c.count++;
    cats.set(e.category, c);
  }
  const prevCats = new Map<ExpenseCategory, number>();
  for (const e of previous) prevCats.set(e.category, (prevCats.get(e.category) ?? 0) + e.amountCents);
  const variableCents = expenses.reduce((a, e) => a + e.amountCents, 0);

  const needsCents =
    fixed.filter((f) => f.bucket !== "wants").reduce((a, f) => a + f.amountCents, 0) +
    expenses.filter((e) => NEEDS.includes(e.category)).reduce((a, e) => a + e.amountCents, 0);
  const wantsCents =
    fixed.filter((f) => f.bucket === "wants").reduce((a, f) => a + f.amountCents, 0) +
    expenses.filter((e) => !NEEDS.includes(e.category)).reduce((a, e) => a + e.amountCents, 0);

  // Proyección: el gasto variable al ritmo de los días que llevamos.
  const daysInMonth = Number(to.slice(8, 10));
  const elapsed = opts.today < from ? 0 : opts.today > to ? daysInMonth : Number(opts.today.slice(8, 10));
  const projectedVariable = elapsed > 0 ? Math.round((variableCents / elapsed) * daysInMonth) : variableCents;
  const projectedLeftCents = incomeCents - fixedCents - projectedVariable;
  const savingsTargetCents = Math.round(incomeCents * 0.2);
  const suggestedSavingsCents = Math.max(0, Math.min(savingsTargetCents, projectedLeftCents));

  const pct = (v: number) => (incomeCents ? Math.round((v / incomeCents) * 1000) / 10 : null);
  const alerts: string[] = [];
  const needsPct = pct(needsCents);
  const wantsPct = pct(wantsCents);
  if (needsPct !== null && needsPct > 50) alerts.push(`Las necesidades van por el ${needsPct} % de los ingresos (la referencia es 50 %).`);
  if (wantsPct !== null && wantsPct > 30) alerts.push(`Los caprichos van por el ${wantsPct} % (la referencia es 30 %).`);
  if (incomeCents && projectedLeftCents < savingsTargetCents) {
    alerts.push(
      projectedLeftCents <= 0
        ? `A este ritmo el mes acabaría en negativo (${formatEuros(projectedLeftCents)}).`
        : `A este ritmo solo podrás ahorrar ${formatEuros(projectedLeftCents)}, menos del 20 % (${formatEuros(savingsTargetCents)}).`,
    );
  }
  for (const [cat, v] of cats) {
    const prev = prevCats.get(cat) ?? 0;
    if (prev > 0 && v.cents > prev * 1.3 && v.cents - prev >= 2000) {
      alerts.push(`En ${CATEGORY_LABELS[cat].toLowerCase()} llevas ${formatEuros(v.cents)}, ${formatEuros(v.cents - prev)} más que el mes pasado.`);
    }
  }

  const comparisons: string[] = [];
  const coffee = cats.get("coffee");
  if (coffee && coffee.count >= 3) {
    const atHome = coffee.count * settings.homeCoffeeCents + settings.thermosCents;
    const saved = coffee.cents - atHome;
    if (saved > 0) {
      comparisons.push(
        `Este mes llevas ${formatEuros(coffee.cents)} en ${coffee.count} cafés. Con un termo y un paquete de café habrías ahorrado unos ${formatEuros(saved)}, ya contando el termo.`,
      );
    }
  }
  const eatingOut = cats.get("eating_out");
  if (eatingOut && eatingOut.count >= 2 && settings.foodWeeklyBudgetCents > 0) {
    const portion = Math.round(settings.foodWeeklyBudgetCents / 14); // comida y cena de una semana
    const saved = eatingOut.cents - eatingOut.count * portion;
    if (saved > 0) {
      comparisons.push(
        `Has comido fuera ${eatingOut.count} veces (${formatEuros(eatingOut.cents)}). Con táper de batch cooking (unos ${formatEuros(portion)} la ración) serían unos ${formatEuros(saved)} menos.`,
      );
    }
  }

  return {
    month,
    incomeCents,
    incomeSource,
    fixedCents,
    variableCents,
    byCategory: [...cats]
      .map(([category, v]) => ({ category, cents: v.cents, count: v.count, previousCents: prevCats.get(category) ?? 0 }))
      .sort((a, b) => b.cents - a.cents),
    rule503020: { needsCents, wantsCents, needsPct, wantsPct, savingsTargetCents, projectedLeftCents, suggestedSavingsCents },
    alerts,
    comparisons,
    disclaimer:
      "No soy asesor financiero: son referencias generales (como la regla 50/30/20) para orientarte. Para decisiones importantes, consulta a un profesional.",
  };
}

/* ------------------------------------------------------------------ */
/* Ticket por foto                                                     */
/* ------------------------------------------------------------------ */

export const ReceiptSchema = z.object({
  is_receipt: z.boolean(),
  merchant: z.string().nullable().catch(null),
  date: z.string().nullable().catch(null),
  total: z.union([z.string(), z.number()]).nullable().catch(null),
  currency: z.string().nullable().catch("EUR"),
  category: ExpenseCategorySchema.catch("other"),
  items: z.array(z.object({ name: z.string(), price: z.union([z.string(), z.number()]).nullable() })).catch([]),
});

export const RECEIPT_PROMPT = [
  "This is a photo of a purchase receipt (probably from Finland).",
  "Extract: merchant name, purchase date (YYYY-MM-DD if visible, else null), the TOTAL paid exactly as printed (e.g. \"12,45\"), currency,",
  `and the best category among: ${ExpenseCategorySchema.options.join(", ")} (supermarkets like K-Market, S-Market, Lidl, Prisma are groceries; cafés are coffee).`,
  "Also list the line items (name and price as printed) if readable.",
  "If it is not a receipt, set is_receipt to false.",
  'Answer with JSON only: {"is_receipt": boolean, "merchant": string|null, "date": string|null, "total": string|null, "currency": string|null, "category": string, "items": [{"name": string, "price": string|null}]}',
].join("\n");

export async function readReceipt(llm: LlmProvider, image: { mime: string; data: string }) {
  const res = await llm.chat({
    vision: true,
    json: true,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: RECEIPT_PROMPT },
          { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } },
        ],
      },
    ],
  });
  const text = (res.content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  return ReceiptSchema.parse(JSON.parse(text));
}
