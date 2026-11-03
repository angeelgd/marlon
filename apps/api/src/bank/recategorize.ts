import type { Expense, ExpenseCategory } from "@marlon/shared";
import { learnCategory, merchantKey } from "./categorize";

/**
 * Cambia la categoría de un gasto. Si es del banco, se recuerda para el comercio y se
 * aplica a sus otros gastos del banco que estaban en "Otros".
 */
export async function recategorizeExpense(db: D1Database, id: string, category: ExpenseCategory): Promise<{ updated: number } | null> {
  const row = await db.prepare(`SELECT merchant, source FROM expenses WHERE id = ?`).bind(id).first<{ merchant: string | null; source: Expense["source"] }>();
  if (!row) return null;
  await db.prepare(`UPDATE expenses SET category = ? WHERE id = ?`).bind(category, id).run();
  let updated = 1;
  if (row.source === "bank") {
    const key = await learnCategory(db, row.merchant, category);
    if (key) {
      const { results } = await db
        .prepare(`SELECT id, merchant FROM expenses WHERE source = 'bank' AND category = 'other' AND id != ?`)
        .bind(id)
        .all<{ id: string; merchant: string | null }>();
      const same = results.filter((r) => merchantKey(r.merchant) === key).map((r) => r.id);
      if (same.length) {
        await db.batch(same.map((sid) => db.prepare(`UPDATE expenses SET category = ? WHERE id = ?`).bind(category, sid)));
        updated += same.length;
      }
    }
  }
  return { updated };
}
