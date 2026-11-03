import type { ExpenseCategory } from "@marlon/shared";
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { addDays } from "../lib/time";
import type { LlmProvider } from "../llm/provider";
import { addExpense } from "../money/expenses";
import { learnedCategories, llmCategories, merchantKey, ruleCategory } from "./categorize";
import { amountToCents, EnableBanking, pickBalance, type ApiTransaction, type SessionResult } from "./enable-banking";

/** Días hacia atrás en la primera descarga (los bancos dan al menos 90 con PSD2). */
const FIRST_SYNC_DAYS = 90;
/** Margen al volver a pedir: el banco puede contabilizar con días de retraso. */
const OVERLAP_DAYS = 7;

export function bankClient(env: Env, fetchImpl?: typeof fetch): EnableBanking | null {
  if (!env.ENABLE_BANKING_APP_ID || !env.ENABLE_BANKING_PRIVATE_KEY) return null;
  return new EnableBanking(env.ENABLE_BANKING_APP_ID.trim(), env.ENABLE_BANKING_PRIVATE_KEY, fetchImpl);
}

const maskIban = (iban: string | null | undefined) => (iban ? `${iban.replace(/\s+/g, "").slice(0, 4)} •••• ${iban.replace(/\s+/g, "").slice(-4)}` : null);

/** Guarda el permiso recién concedido y sus cuentas. */
export async function saveLink(db: D1Database, s: SessionResult, fallbackAspsp: { name: string; country: string }): Promise<string> {
  const id = newId("bnk");
  const aspsp = s.aspsp ?? fallbackAspsp;
  const stmts = [
    db
      .prepare(`INSERT INTO bank_links (id, session_id, aspsp_name, aspsp_country, valid_until) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, s.session_id, aspsp.name, aspsp.country, s.valid_until),
    ...s.accounts.map((a) =>
      db
        .prepare(
          `INSERT INTO bank_accounts (uid, link_id, iban, name, currency) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(uid) DO UPDATE SET link_id = ?2, iban = ?3, name = ?4, currency = ?5`,
        )
        .bind(a.uid!, id, a.account_id?.iban ?? null, a.name ?? a.product ?? a.details ?? null, a.currency ?? null),
    ),
  ];
  await db.batch(stmts);
  return id;
}

async function shortHash(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface NormalizedTx {
  id: string;
  accountUid: string;
  date: string;
  amountCents: number;
  currency: string;
  counterparty: string | null;
  description: string | null;
  status: "booked" | "pending";
  kind: "normal" | "own_transfer";
}

export async function normalizeTx(accountUid: string, t: ApiTransaction, ownIbans: Set<string>): Promise<NormalizedTx | null> {
  const cents = amountToCents(t.transaction_amount);
  const date = (t.booking_date || t.value_date || t.transaction_date || "").slice(0, 10);
  if (cents === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const debit = t.credit_debit_indicator !== "CRDT";
  const counterparty = (debit ? t.creditor?.name : t.debtor?.name)?.trim() || null;
  const remit = Array.isArray(t.remittance_information) ? t.remittance_information.join(" ") : (t.remittance_information ?? "");
  const description = remit.replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const otherIban = (debit ? t.creditor_account?.iban : t.debtor_account?.iban)?.replace(/\s+/g, "") ?? "";
  const ref = t.entry_reference || t.transaction_id || (await shortHash(`${date}|${debit ? "-" : "+"}${cents}|${counterparty}|${description}`));
  return {
    id: `${accountUid}:${ref}`,
    accountUid,
    date,
    amountCents: debit ? -cents : cents,
    currency: t.transaction_amount?.currency ?? "EUR",
    counterparty: counterparty ? counterparty.slice(0, 100) : null,
    description,
    status: t.status === "PDNG" || (!t.booking_date && t.status !== "BOOK") ? "pending" : "booked",
    kind: otherIban && ownIbans.has(otherIban) ? "own_transfer" : "normal",
  };
}

export interface BankSyncResult {
  accounts: number;
  newTransactions: number;
  newExpenses: number;
  matched: number;
  errors: string[];
  skipped?: "no_credentials" | "no_links";
}

/**
 * Descarga saldos y movimientos de todas las cuentas conectadas. Los cargos ya
 * contabilizados pasan a ser gastos (o se enlazan con uno apuntado a mano el mismo
 * importe con 2 días de margen, para no contarlo dos veces).
 */
export async function syncBank(
  env: Env,
  opts: { now?: number; fetchImpl?: typeof fetch; llm?: LlmProvider | null } = {},
): Promise<BankSyncResult> {
  const now = opts.now ?? Date.now();
  const result: BankSyncResult = { accounts: 0, newTransactions: 0, newExpenses: 0, matched: 0, errors: [] };
  const client = bankClient(env, opts.fetchImpl);
  if (!client) return { ...result, skipped: "no_credentials" };
  const db = env.DB;
  const nowIso = new Date(now).toISOString();

  const { results: links } = await db
    .prepare(`SELECT id, aspsp_name, valid_until FROM bank_links WHERE status = 'active'`)
    .all<{ id: string; aspsp_name: string; valid_until: string | null }>();
  if (!links.length) return { ...result, skipped: "no_links" };

  const { results: allAccounts } = await db.prepare(`SELECT uid, link_id, iban FROM bank_accounts`).all<{ uid: string; link_id: string; iban: string | null }>();
  const ownIbans = new Set(allAccounts.map((a) => a.iban?.replace(/\s+/g, "")).filter((x): x is string => Boolean(x)));
  const fresh: NormalizedTx[] = [];

  for (const link of links) {
    if (link.valid_until && link.valid_until < nowIso) {
      await db.prepare(`UPDATE bank_links SET status = 'expired' WHERE id = ?`).bind(link.id).run();
      result.errors.push(`El permiso de ${link.aspsp_name} ha caducado: vuelve a conectarlo.`);
      continue;
    }
    let linkError: string | null = null;
    for (const acc of allAccounts.filter((a) => a.link_id === link.id)) {
      try {
        const bal = pickBalance(await client.balances(acc.uid));
        if (bal) {
          await db.prepare(`UPDATE bank_accounts SET balance_cents = ?, balance_at = ? WHERE uid = ?`).bind(bal.cents, nowIso, acc.uid).run();
        }
        const last = await db
          .prepare(`SELECT MAX(booking_date) AS d FROM bank_transactions WHERE account_uid = ? AND status = 'booked'`)
          .bind(acc.uid)
          .first<{ d: string | null }>();
        const today = nowIso.slice(0, 10);
        const from = last?.d ? addDays(last.d, -OVERLAP_DAYS) : addDays(today, -FIRST_SYNC_DAYS);
        const raw = await client.transactions(acc.uid, from);
        // Los pendientes cambian de referencia al contabilizarse: se rehacen en cada descarga.
        await db.prepare(`DELETE FROM bank_transactions WHERE account_uid = ? AND status = 'pending'`).bind(acc.uid).run();
        for (const t of raw) {
          const n = await normalizeTx(acc.uid, t, ownIbans);
          if (!n) continue;
          const ins = await db
            .prepare(
              `INSERT OR IGNORE INTO bank_transactions (id, account_uid, booking_date, amount_cents, currency, counterparty, description, status, kind)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(n.id, n.accountUid, n.date, n.amountCents, n.currency, n.counterparty, n.description, n.status, n.kind)
            .run();
          if ((ins.meta.changes ?? 0) > 0 && n.status === "booked") {
            result.newTransactions++;
            fresh.push(n);
          }
        }
        result.accounts++;
      } catch (err) {
        linkError = (err as Error).message;
        result.errors.push(`${link.aspsp_name}: ${linkError}`);
      }
    }
    await db.prepare(`UPDATE bank_links SET last_sync_at = ?, last_error = ? WHERE id = ?`).bind(nowIso, linkError, link.id).run();
  }

  await expenseFromTransactions(db, fresh.filter((t) => t.amountCents < 0 && t.kind === "normal" && t.currency === "EUR"), opts.llm ?? null, result);
  return result;
}

async function expenseFromTransactions(db: D1Database, txs: NormalizedTx[], llm: LlmProvider | null, result: BankSyncResult) {
  if (!txs.length) return;
  const keys = txs.map((t) => merchantKey(t.counterparty ?? t.description)).filter((k): k is string => Boolean(k));
  const learned = await learnedCategories(db, keys);
  const cats: (ExpenseCategory | null)[] = txs.map((t) => {
    const k = merchantKey(t.counterparty ?? t.description);
    return (k && learned.get(k)) || ruleCategory(`${t.counterparty ?? ""} ${t.description ?? ""}`);
  });
  if (llm) {
    const unknown = txs.map((t, i) => ({ t, i })).filter(({ i }) => cats[i] === null).slice(0, 40);
    const guesses = await llmCategories(llm, unknown.map(({ t }) => ({ merchant: t.counterparty, description: t.description, cents: -t.amountCents })));
    unknown.forEach(({ i }, j) => (cats[i] = guesses[j] ?? null));
  }

  for (const [i, t] of txs.entries()) {
    const cents = -t.amountCents;
    // ¿Ya lo apuntó a mano (ticket, voz, texto)? Se enlaza en vez de duplicarlo.
    const manual = await db
      .prepare(
        `SELECT id FROM expenses WHERE source != 'bank' AND amount_cents = ? AND date BETWEEN ? AND ?
         AND id NOT IN (SELECT expense_id FROM bank_transactions WHERE expense_id IS NOT NULL) ORDER BY date LIMIT 1`,
      )
      .bind(cents, addDays(t.date, -2), addDays(t.date, 2))
      .first<{ id: string }>();
    let expenseId: string | null = manual?.id ?? null;
    if (expenseId) {
      result.matched++;
    } else {
      try {
        const e = await addExpense(db, {
          date: t.date,
          amountCents: cents,
          merchant: t.counterparty ?? t.description?.slice(0, 100) ?? null,
          category: cats[i] ?? "other",
          note: t.description && t.description !== t.counterparty ? t.description : null,
          source: "bank",
        });
        expenseId = e.id;
        result.newExpenses++;
      } catch {
        // Importes fuera de rango (p. ej. un traspaso enorme): se quedan solo como movimiento.
      }
    }
    if (expenseId) await db.prepare(`UPDATE bank_transactions SET expense_id = ? WHERE id = ?`).bind(expenseId, t.id).run();
  }
}

export interface BankStatus {
  configured: boolean;
  links: {
    id: string;
    bank: string;
    validUntil: string | null;
    status: "active" | "expired" | "revoked";
    lastSyncAt: string | null;
    lastError: string | null;
    accounts: { uid: string; name: string | null; iban: string | null; currency: string | null; balanceCents: number | null; balanceAt: string | null }[];
  }[];
}

export async function bankStatus(env: Env): Promise<BankStatus> {
  const db = env.DB;
  const { results: links } = await db
    .prepare(`SELECT id, aspsp_name, valid_until, status, last_sync_at, last_error FROM bank_links WHERE status != 'revoked' ORDER BY created_at`)
    .all<{ id: string; aspsp_name: string; valid_until: string | null; status: "active" | "expired"; last_sync_at: string | null; last_error: string | null }>();
  const { results: accs } = await db
    .prepare(`SELECT uid, link_id, iban, name, currency, balance_cents, balance_at FROM bank_accounts`)
    .all<{ uid: string; link_id: string; iban: string | null; name: string | null; currency: string | null; balance_cents: number | null; balance_at: string | null }>();
  return {
    configured: Boolean(env.ENABLE_BANKING_APP_ID && env.ENABLE_BANKING_PRIVATE_KEY),
    links: links.map((l) => ({
      id: l.id,
      bank: l.aspsp_name,
      validUntil: l.valid_until,
      status: l.status,
      lastSyncAt: l.last_sync_at,
      lastError: l.last_error,
      accounts: accs
        .filter((a) => a.link_id === l.id)
        .map((a) => ({ uid: a.uid, name: a.name, iban: maskIban(a.iban), currency: a.currency, balanceCents: a.balance_cents, balanceAt: a.balance_at })),
    })),
  };
}

export interface BankTx {
  id: string;
  date: string;
  amountCents: number;
  counterparty: string | null;
  description: string | null;
  status: "booked" | "pending";
  kind: "normal" | "own_transfer";
  expenseId: string | null;
}

export async function listBankTransactions(
  db: D1Database,
  q: { from: string; to: string; search?: string; limit?: number },
): Promise<BankTx[]> {
  const like = q.search ? `%${q.search.toLowerCase()}%` : null;
  const { results } = await db
    .prepare(
      `SELECT id, booking_date, amount_cents, counterparty, description, status, kind, expense_id FROM bank_transactions
       WHERE booking_date BETWEEN ?1 AND ?2
         AND (?3 IS NULL OR lower(coalesce(counterparty, '')) LIKE ?3 OR lower(coalesce(description, '')) LIKE ?3)
       ORDER BY booking_date DESC, created_at DESC LIMIT ?4`,
    )
    .bind(q.from, q.to, like, Math.min(q.limit ?? 200, 500))
    .all<{ id: string; booking_date: string; amount_cents: number; counterparty: string | null; description: string | null; status: BankTx["status"]; kind: BankTx["kind"]; expense_id: string | null }>();
  return results.map((r) => ({
    id: r.id,
    date: r.booking_date,
    amountCents: r.amount_cents,
    counterparty: r.counterparty,
    description: r.description,
    status: r.status,
    kind: r.kind,
    expenseId: r.expense_id,
  }));
}
