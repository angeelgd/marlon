import { CATEGORY_LABELS, ExpenseCategorySchema, formatEuros } from "@marlon/shared";
import { z } from "zod";
import { toLocalIso } from "../../lib/time";
import {
  addExpense,
  deleteExpense,
  expenseSummary,
  parseAmount,
  readReceipt,
  setBudgetItem,
} from "../../money/expenses";
import { currentMonth, logActualShift, monthPay } from "../../money/payroll";
import { saveSettings } from "../../db/settings";
import { bankStatus, listBankTransactions, syncBank } from "../../bank/sync";
import { defineTool, requireFinancial, ToolError, type Tool, type ToolContext } from "./types";

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");
const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM");
const Month = z.string().regex(/^\d{4}-\d{2}$/, "Formato YYYY-MM");

const today = (ctx: ToolContext) => toLocalIso(ctx.now, ctx.settings.timezone).slice(0, 10);
const eur = (cents: number) => formatEuros(cents);

export const logActualShiftTool = defineTool({
  name: "log_actual_shift",
  description:
    "Registra las horas REALES de trabajo de un día ('hoy salí a las 21:00', 'ayer entré a las 16:00', 'el viernes no fui'). Lo que no se diga se toma del horario planificado. No cambia el horario planificado ni el calendario.",
  schema: z.object({
    date: LocalDate.optional().describe("Por defecto, hoy."),
    start: HHMM.optional(),
    end: HHMM.optional(),
    day_off: z.boolean().optional().describe("true si al final no trabajó ese día."),
    note: z.string().max(300).optional(),
  }),
  async run(a, ctx) {
    if (!a.day_off && !a.start && !a.end) throw new ToolError("Indica la hora de entrada, la de salida o day_off.");
    return logActualShift(ctx.db, { date: a.date ?? today(ctx), start: a.start, end: a.end, dayOff: a.day_off, note: a.note });
  },
});

export const calcMonthlyPay = defineTool({
  name: "calc_monthly_pay",
  description:
    "Calcula el sueldo bruto estimado del mes con las horas reales y con el horario planificado completo, la diferencia y los días que difieren (para confirmarlos). Marca importes por confirmar.",
  schema: z.object({ month: Month.optional().describe("Por defecto, el mes actual.") }),
  async run(a, ctx) {
    requireFinancial(ctx);
    const m = await monthPay(ctx.db, a.month ?? currentMonth(ctx.now, ctx.settings.timezone), ctx.settings);
    if (m.unresolved.length) {
      ctx.out.quickReplies.push("Cuenta según el día del calendario", "Todo según el día de entrada");
    }
    return {
      month: m.month,
      actual: eur(m.actualCents),
      if_full_schedule: eur(m.plannedCents),
      difference: eur(m.differenceCents),
      actual_hours: m.actualHours,
      planned_hours: m.plannedHours,
      differing_days: m.differingDays.map((d) => ({
        date: d.date,
        planned: d.planned ?? "libre",
        actual: d.actual ?? "no trabajó",
        planned_eur: d.plannedEuros,
        actual_eur: d.actualEuros,
      })),
      to_confirm: m.toConfirm,
      midnight_rule_needed: m.unresolved.length
        ? {
            shifts: m.unresolved,
            question:
              "Hay turnos que cruzan la medianoche hacia domingo o festivo. ¿Las horas después de las 00:00 se pagan como domingo/festivo (día del calendario) o como el día en que empezó el turno?",
          }
        : undefined,
      missing_rules_for: m.missingRules.length ? m.missingRules : undefined,
      eve_mode: ctx.settings.payEveMode,
      disclaimer: m.disclaimer,
    };
  },
});

export const setPayOption = defineTool({
  name: "set_pay_option",
  description:
    "Cambia cómo se calculan los casos dudosos del sueldo: el modo de la víspera de festivo y la regla de los turnos que cruzan la medianoche hacia domingo o festivo.",
  schema: z.object({
    eve_mode: z.enum(["probable", "minimum"]).optional(),
    midnight_rule: z.enum(["calendar_day", "shift_start", "ask"]).optional(),
  }),
  async run(a, ctx) {
    const patch: Record<string, string> = {};
    if (a.eve_mode) patch.payEveMode = a.eve_mode;
    if (a.midnight_rule) patch.payMidnightRule = a.midnight_rule;
    ctx.settings = await saveSettings(ctx.db, patch);
    return { eve_mode: ctx.settings.payEveMode, midnight_rule: ctx.settings.payMidnightRule };
  },
});

export const logExpense = defineTool({
  name: "log_expense",
  description: "Apunta un gasto ('me acabo de gastar 4,50 en un café'). Importe en euros.",
  schema: z.object({
    amount: z.union([z.number().positive(), z.string()]).describe("Euros, p. ej. 4.5 o \"4,50\"."),
    category: ExpenseCategorySchema,
    merchant: z.string().max(100).optional(),
    date: LocalDate.optional(),
    note: z.string().max(300).optional(),
    source: z.enum(["text", "voice"]).default("text"),
  }),
  async run(a, ctx) {
    requireFinancial(ctx);
    const cents = parseAmount(a.amount);
    if (!cents) throw new ToolError("No entiendo el importe.", "Usa un número en euros, p. ej. 4.5.");
    const e = await addExpense(ctx.db, {
      date: a.date ?? today(ctx),
      amountCents: cents,
      merchant: a.merchant,
      category: a.category,
      note: a.note,
      source: a.source,
    });
    return { saved: { id: e.id, amount: eur(e.amountCents), category: CATEGORY_LABELS[e.category], date: e.date, merchant: e.merchant } };
  },
});

export const parseReceiptPhoto = defineTool({
  name: "parse_receipt_photo",
  description: "Lee la foto de un ticket adjunta y apunta el gasto (importe, comercio, fecha y categoría).",
  schema: z.object({ image_index: z.number().int().min(0).default(0) }),
  async run(a, ctx) {
    requireFinancial(ctx);
    const imageId = ctx.imageIds[a.image_index];
    if (!imageId) throw new ToolError("No hay ninguna imagen adjunta con ese índice.");
    const img = await ctx.db.prepare(`SELECT mime, data FROM pending_images WHERE id = ?`).bind(imageId).first<{ mime: string; data: string }>();
    if (!img) throw new ToolError("La imagen ya no está disponible.");
    const llm = ctx.llm({ sensitivity: "financial", allowFreeTier: true });
    const r = await readReceipt(llm, img);
    await ctx.db.prepare(`DELETE FROM pending_images WHERE id = ?`).bind(imageId).run();
    if (!r.is_receipt) return { is_receipt: false, message: "No parece un ticket. Pregunta qué es." };
    const cents = r.total !== null ? parseAmount(r.total) : null;
    if (!cents) return { is_receipt: true, message: "No leo bien el total. Pregunta el importe.", merchant: r.merchant };
    if (r.currency && !/eur|€/i.test(r.currency)) {
      return { is_receipt: true, message: `El ticket está en ${r.currency}. Pregunta el importe en euros.`, merchant: r.merchant };
    }
    const date = r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date <= today(ctx) ? r.date : today(ctx);
    const e = await addExpense(ctx.db, { date, amountCents: cents, merchant: r.merchant, category: r.category, source: "receipt" });
    return {
      saved: { id: e.id, amount: eur(cents), merchant: r.merchant, date, category: CATEGORY_LABELS[e.category] },
      items: r.items.slice(0, 20),
    };
  },
});

export const deleteExpenseTool = defineTool({
  name: "delete_expense",
  description: "Borra un gasto apuntado por error (usa el id que devolvió log_expense).",
  schema: z.object({ id: z.string() }),
  async run(a, ctx) {
    if (!(await deleteExpense(ctx.db, a.id))) throw new ToolError("Ese gasto no existe.");
    return { deleted: a.id };
  },
});

export const setBudgetItemTool = defineTool({
  name: "set_budget_item",
  description:
    "Guarda o actualiza un ingreso mensual (sueldo neto) o un gasto fijo (alquiler, teléfono, gimnasio, transporte). Importe mensual en euros.",
  schema: z.object({
    kind: z.enum(["income", "fixed"]),
    name: z.string().min(1).max(60),
    amount: z.union([z.number().positive(), z.string()]),
    bucket: z.enum(["needs", "wants", "savings"]).optional().describe("Solo gastos fijos: necesidad o capricho."),
  }),
  async run(a, ctx) {
    requireFinancial(ctx);
    const cents = parseAmount(a.amount);
    if (!cents) throw new ToolError("No entiendo el importe.");
    const item = await setBudgetItem(ctx.db, { kind: a.kind, name: a.name, amountCents: cents, bucket: a.bucket });
    return { saved: { ...item, amount: eur(item.amountCents) } };
  },
});

export const expenseSummaryTool = defineTool({
  name: "expense_summary",
  description:
    "Resumen de gastos del mes: por categoría, comparado con el mes anterior, la regla 50/30/20, cuánto ahorrar y comparaciones concretas (cafés, comer fuera).",
  schema: z.object({ month: Month.optional() }),
  async run(a, ctx) {
    requireFinancial(ctx);
    const month = a.month ?? currentMonth(ctx.now, ctx.settings.timezone);
    let payEstimate: number | null = null;
    try {
      payEstimate = (await monthPay(ctx.db, month, ctx.settings)).actualCents || null;
    } catch {
      payEstimate = null;
    }
    const s = await expenseSummary(ctx.db, month, ctx.settings, { today: today(ctx), payEstimateCents: payEstimate });
    return {
      month: s.month,
      income: eur(s.incomeCents),
      income_source:
        s.incomeSource === "budget"
          ? "sueldo de los ajustes"
          : s.incomeSource === "pay_estimate"
            ? "estimación BRUTA de las horas (pide el neto para afinar)"
            : "desconocido: pregunta el sueldo neto",
      fixed: eur(s.fixedCents),
      variable: eur(s.variableCents),
      by_category: s.byCategory.map((c) => ({
        category: CATEGORY_LABELS[c.category],
        spent: eur(c.cents),
        times: c.count,
        previous_month: eur(c.previousCents),
      })),
      rule_50_30_20: {
        needs: `${eur(s.rule503020.needsCents)}${s.rule503020.needsPct !== null ? ` (${s.rule503020.needsPct} %)` : ""}`,
        wants: `${eur(s.rule503020.wantsCents)}${s.rule503020.wantsPct !== null ? ` (${s.rule503020.wantsPct} %)` : ""}`,
        savings_target: eur(s.rule503020.savingsTargetCents),
        projected_left: eur(s.rule503020.projectedLeftCents),
        suggested_savings: eur(s.rule503020.suggestedSavingsCents),
      },
      alerts: s.alerts,
      comparisons: s.comparisons,
      disclaimer: s.disclaimer,
    };
  },
});

export const bankOverviewTool = defineTool({
  name: "bank_overview",
  description:
    "Saldos de las cuentas bancarias conectadas y movimientos reales del banco (cargos e ingresos) en un periodo, con búsqueda por comercio o concepto. Úsalo para '¿cuánto tengo?', '¿qué he pagado en Wolt este mes?' o '¿me ha llegado la nómina?'.",
  schema: z.object({
    from: LocalDate.optional().describe("Por defecto, el día 1 del mes actual."),
    to: LocalDate.optional(),
    search: z.string().max(60).optional().describe("Texto a buscar en comercio o concepto."),
    sync_first: z.boolean().default(false).describe("Descargar antes lo último del banco (gasta una de las pocas consultas diarias)."),
  }),
  async run(a, ctx) {
    requireFinancial(ctx);
    let synced: string | undefined;
    if (a.sync_first) {
      const r = await syncBank(ctx.env, { now: ctx.now, fetchImpl: ctx.fetchImpl, llm: null });
      synced = r.skipped ? undefined : `${r.newTransactions} movimientos nuevos${r.errors.length ? `; avisos: ${r.errors.join(" ")}` : ""}`;
    }
    const status = await bankStatus(ctx.env);
    if (!status.links.length) {
      throw new ToolError("No hay ningún banco conectado.", "Explica que puede conectarlo en Ajustes > Conexiones > Banco.");
    }
    const t = today(ctx);
    const from = a.from ?? `${t.slice(0, 7)}-01`;
    const txs = await listBankTransactions(ctx.db, { from, to: a.to ?? t, search: a.search, limit: 80 });
    const out = txs.filter((x) => x.kind === "normal");
    return {
      synced,
      accounts: status.links.flatMap((l) =>
        l.accounts.map((acc) => ({
          bank: l.bank,
          account: acc.name ?? acc.iban,
          balance: acc.balanceCents === null ? "desconocido" : eur(acc.balanceCents),
          balance_at: acc.balanceAt,
          consent: l.status === "active" ? `válido hasta ${l.validUntil?.slice(0, 10) ?? "?"}` : "caducado: hay que reconectar",
        })),
      ),
      period: { from, to: a.to ?? t },
      total_out: eur(-out.filter((x) => x.amountCents < 0).reduce((s, x) => s + x.amountCents, 0)),
      total_in: eur(out.filter((x) => x.amountCents > 0).reduce((s, x) => s + x.amountCents, 0)),
      transactions: out.slice(0, 40).map((x) => ({
        date: x.date,
        amount: eur(x.amountCents),
        who: x.counterparty,
        concept: x.description?.slice(0, 80) ?? undefined,
        pending: x.status === "pending" || undefined,
      })),
      more: out.length > 40 ? out.length - 40 : undefined,
    };
  },
});

export const MONEY_TOOLS: Tool[] = [
  bankOverviewTool,
  logActualShiftTool,
  calcMonthlyPay,
  setPayOption,
  logExpense,
  parseReceiptPhoto,
  deleteExpenseTool,
  setBudgetItemTool,
  expenseSummaryTool,
] as Tool[];
