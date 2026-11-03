import { AlertTriangle, ChevronLeft, ChevronRight, Landmark, RefreshCw, X } from "lucide-react";
import { CATEGORY_LABELS, formatEuros, type ExpenseCategory, type PayRuleSet, type PayRules, type Settings } from "@marlon/shared";
import { useCallback, useEffect, useState } from "react";
import { api, type BankStatus, type DayComparison, type MoneyData } from "../lib/api";

interface Props {
  today: string;
  onSaveSettings(patch: Partial<Settings>): Promise<void>;
  onToast(text: string): void;
}

const CATS = Object.keys(CATEGORY_LABELS) as ExpenseCategory[];

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const monthName = (month: string) =>
  new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`));
const dayName = (date: string) =>
  new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const euros3 = (v: number | null) => (v === null ? "?" : `${v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 3 })} €`);
const toCents = (s: string) => {
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

export function Money({ today, onSaveSettings, onToast }: Props) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState<MoneyData | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [bank, setBank] = useState<BankStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    api.bank().then(setBank, () => setBank(null));
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await api.money(month));
    } catch (err) {
      onToast((err as Error).message);
    }
  }, [month, onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) onToast(ok);
      await load();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  if (!data) return <section className="money"><p className="muted">Cargando…</p></section>;
  const { pay, summary } = data;
  const r = summary.rule503020;

  return (
    <section className="money" aria-label="Dinero">
      <header className="month-nav">
        <button className="icon-btn sm" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Mes anterior"><ChevronLeft size={18} strokeWidth={1.75} /></button>
        <h2>{monthName(month)}</h2>
        <button className="icon-btn sm" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Mes siguiente"><ChevronRight size={18} strokeWidth={1.75} /></button>
      </header>

      {bank && bank.links.some((l) => l.status === "active") && (
        <div className="card">
          <div className="card-head">
            <span className="eyebrow">
              <Landmark size={12} strokeWidth={2} style={{ verticalAlign: -1, marginRight: 6 }} />
              Saldo en el banco
            </span>
            <button
              className="icon-btn sm"
              aria-label="Actualizar desde el banco"
              disabled={syncing}
              onClick={async () => {
                setSyncing(true);
                try {
                  const r = await api.bankSync();
                  onToast(r.errors.length ? r.errors[0]! : r.newExpenses ? `${r.newExpenses} gastos nuevos del banco` : "Todo al día");
                  setBank(await api.bank());
                  await load();
                } catch (err) {
                  onToast((err as Error).message);
                } finally {
                  setSyncing(false);
                }
              }}
            >
              <RefreshCw size={16} strokeWidth={1.75} className={syncing ? "spin" : ""} />
            </button>
          </div>
          <p className="hero-amount">
            {formatEuros(bank.links.filter((l) => l.status === "active").flatMap((l) => l.accounts).reduce((t, a) => t + (a.balanceCents ?? 0), 0))}
          </p>
          <ul className="bank-accounts">
            {bank.links
              .filter((l) => l.status === "active")
              .flatMap((l) => l.accounts.map((a) => ({ ...a, bank: l.bank })))
              .map((a) => (
                <li key={a.uid}>
                  <span>
                    {a.name ?? a.bank} <span className="muted small">{a.iban}</span>
                  </span>
                  <b className="num">{a.balanceCents === null ? "—" : formatEuros(a.balanceCents)}</b>
                </li>
              ))}
          </ul>
          <p className="muted small">Los cargos del banco entran solos como gastos. Si alguno está mal clasificado, cámbialo abajo y Marlon lo recordará.</p>
        </div>
      )}

      <div className="card">
        <span className="eyebrow">Sueldo estimado · bruto</span>
        <p className="hero-amount">{formatEuros(pay.actualCents)}</p>
        <p className="muted small">{pay.actualHours.toLocaleString("es-ES")} h trabajadas según tus horas reales</p>
        <div className="kpis two">
          <div><span className="muted small">Con el horario completo</span><b>{formatEuros(pay.plannedCents)}</b><span className="muted small">{pay.plannedHours.toLocaleString("es-ES")} h</span></div>
          <div><span className="muted small">Diferencia</span><b className={pay.differenceCents < 0 ? "neg" : ""}>{formatEuros(pay.differenceCents)}</b></div>
        </div>
        {pay.unresolved.length > 0 && (
          <div className="warn">
            <p>Turnos que cruzan la medianoche hacia domingo o festivo: ¿cómo se pagan las horas después de las 00:00?</p>
            {pay.unresolved.map((u) => (
              <p key={u.date} className="small">{dayName(u.date)}: {euros3(u.calendarDayEuros)} según el día del calendario, o {euros3(u.shiftStartEuros)} según el día de entrada.</p>
            ))}
            <div className="actions-row">
              <button className="btn small" onClick={() => act(() => onSaveSettings({ payMidnightRule: "calendar_day" }), "Guardado")}>Día del calendario</button>
              <button className="btn ghost small" onClick={() => act(() => onSaveSettings({ payMidnightRule: "shift_start" }), "Guardado")}>Día de entrada</button>
            </div>
          </div>
        )}
        {pay.toConfirm.length > 0 && (
          <ul className="small muted confirm-list">
            {[...new Map(pay.toConfirm.map((t) => [`${t.date}${t.reason}`, t])).values()].map((t) => (
              <li key={`${t.date}${t.reason}`}><AlertTriangle size={14} strokeWidth={1.75} /> <span>{dayName(t.date)}: {t.reason}</span></li>
            ))}
          </ul>
        )}
        <p className="muted small">{pay.disclaimer}</p>
      </div>

      <div className="card">
        <h3>Turnos del mes</h3>
        {pay.days.length === 0 && <p className="muted small">No hay turnos este mes.</p>}
        <ul className="shift-list">
          {pay.days.map((d) => (
            <ShiftRow
              key={d.date}
              day={d}
              editing={editing === d.date}
              onEdit={() => setEditing(editing === d.date ? null : d.date)}
              onSave={(body) => act(() => api.setActualShift(d.date, body), "Horas guardadas").then(() => setEditing(null))}
              onReset={() => act(() => api.clearActualShift(d.date), "Vuelve a contar lo planificado").then(() => setEditing(null))}
            />
          ))}
        </ul>
        <p className="muted small">Si no dices nada, se cuenta la hora planificada. Toca un día para cambiar la entrada o la salida reales.</p>
      </div>

      <div className="card">
        <h3>Este mes</h3>
        <p className="small">
          Ingresos {formatEuros(summary.incomeCents)}
          {summary.incomeSource === "pay_estimate" && " (estimación bruta; añade tu sueldo neto abajo)"}
          {summary.incomeSource === "none" && " (añade tu sueldo neto abajo)"} · fijos {formatEuros(summary.fixedCents)} · gastos {formatEuros(summary.variableCents)}
        </p>
        {summary.incomeCents > 0 && (
          <div className="bars">
            <Bar label="Necesidades" pct={r.needsPct ?? 0} ref_={50} value={formatEuros(r.needsCents)} />
            <Bar label="Caprichos" pct={r.wantsPct ?? 0} ref_={30} value={formatEuros(r.wantsCents)} />
            <p className="small">
              Ahorro objetivo (20 %): <b>{formatEuros(r.savingsTargetCents)}</b>. A este ritmo te quedarán {formatEuros(r.projectedLeftCents)}: aparta{" "}
              <b>{formatEuros(r.suggestedSavingsCents)}</b>.
            </p>
          </div>
        )}
        {[...summary.alerts, ...summary.comparisons].map((t) => (
          <p key={t} className="small tip">{t}</p>
        ))}
        {summary.byCategory.length > 0 && (
          <ul className="cat-list small">
            {summary.byCategory.map((c) => (
              <li key={c.category}>
                <span>{CATEGORY_LABELS[c.category]}</span>
                <span>{formatEuros(c.cents)} <span className="muted">({c.count})</span></span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">{summary.disclaimer}</p>
      </div>

      <div className="card">
        <h3>Gastos</h3>
        <ExpenseForm today={today} onAdd={(e) => act(() => api.addExpense(e), "Gasto apuntado")} />
        <ul className="expense-list">
          {data.expenses.map((e) => (
            <li key={e.id}>
              <div className="exp-main">
                <span>{e.merchant || CATEGORY_LABELS[e.category]}</span>
                <span className="exp-meta">
                  <span className="muted small">
                    {dayName(e.date)}
                    {e.source === "receipt" ? " · ticket" : e.source === "bank" ? " · banco" : ""}
                  </span>
              <select
                className="cat-select"
                value={e.category}
                aria-label="Categoría"
                onChange={(ev) =>
                  act(async () => {
                    const r = await api.recategorizeExpense(e.id, ev.target.value);
                    if (r.updated > 1) onToast(`Cambiados ${r.updated} gastos de ese comercio`);
                  })
                }
              >
                {CATS.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
                </span>
              </div>
              <span>{formatEuros(e.amountCents)}</span>
              <button className="icon-btn sm quiet" aria-label="Borrar gasto" onClick={() => act(() => api.deleteExpense(e.id), "Gasto borrado")}><X size={15} strokeWidth={1.75} /></button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Sueldo, alquiler y gastos fijos</h3>
        <ul className="expense-list">
          {data.budget.map((b) => (
            <li key={b.id}>
              <div>
                <span>{b.name}</span>
                <span className="muted small"> {b.kind === "income" ? "ingreso" : b.bucket === "wants" ? "fijo, capricho" : "fijo, necesidad"}</span>
              </div>
              <span>{formatEuros(b.amountCents)}/mes</span>
              <button className="icon-btn sm quiet" aria-label="Borrar" onClick={() => act(() => api.deleteBudget(b.id))}><X size={15} strokeWidth={1.75} /></button>
            </li>
          ))}
        </ul>
        <BudgetForm onAdd={(b) => act(() => api.setBudget(b), "Guardado")} />
      </div>

      <PayRulesCard sets={data.ruleSets} options={data.options} onSaveSettings={(p) => act(() => onSaveSettings(p), "Guardado")} onSave={(s) => act(() => api.savePayRules(s), "Tabla guardada")} onDelete={(id) => act(() => api.deletePayRules(id), "Tabla borrada")} />
    </section>
  );
}

function Bar({ label, pct, ref_, value }: { label: string; pct: number; ref_: number; value: string }) {
  return (
    <div className="bar-row">
      <span className="small">{label} {pct} % <span className="muted">(ref. {ref_} %)</span></span>
      <div className="bar"><div className={pct > ref_ ? "over" : ""} style={{ width: `${Math.min(100, pct)}%` }} /><i style={{ left: `${ref_}%` }} /></div>
      <span className="small muted">{value}</span>
    </div>
  );
}

function ShiftRow(props: {
  day: DayComparison;
  editing: boolean;
  onEdit(): void;
  onSave(b: { start?: string; end?: string; dayOff?: boolean }): void;
  onReset(): void;
}) {
  const d = props.day;
  const [start, setStart] = useState(d.actual?.split("-")[0] ?? d.planned?.split("-")[0] ?? "");
  const [end, setEnd] = useState(d.actual?.split("-")[1] ?? d.planned?.split("-")[1] ?? "");
  const differs = d.planned !== d.actual;
  return (
    <li className={differs ? "differs" : ""}>
      <button className="shift-main" onClick={props.onEdit}>
        <span>{dayName(d.date)}{d.dayName ? ` · ${d.dayName}` : ""}</span>
        <span className="small">
          {differs ? (
            <>
              <s className="muted">{d.planned ?? "libre"}</s> {d.actual ?? "no fui"}
            </>
          ) : (
            d.actual
          )}
        </span>
        <span>{euros3(d.actualEuros)}</span>
      </button>
      {props.editing && (
        <div className="shift-edit">
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Entrada real" />
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="Salida real" />
          <button className="btn small" onClick={() => props.onSave({ start, end })}>Guardar</button>
          <button className="btn ghost small" onClick={() => props.onSave({ dayOff: true })}>No fui</button>
          {!d.assumed && <button className="btn ghost small" onClick={props.onReset}>Como planificado</button>}
        </div>
      )}
    </li>
  );
}

function ExpenseForm({ today, onAdd }: { today: string; onAdd(e: { date: string; amountCents: number; category: ExpenseCategory; merchant: string | null }): void }) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<ExpenseCategory>("groceries");
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState(today);
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const cents = toCents(amount);
        if (!cents) return;
        onAdd({ date, amountCents: cents, category, merchant: merchant.trim() || null });
        setAmount("");
        setMerchant("");
      }}
    >
      <input inputMode="decimal" placeholder="Importe €" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Importe" required />
      <select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)} aria-label="Categoría">
        {CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
      </select>
      <input placeholder="Dónde (opcional)" value={merchant} onChange={(e) => setMerchant(e.target.value)} aria-label="Comercio" />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Fecha" />
      <button className="btn small">Añadir</button>
    </form>
  );
}

function BudgetForm({ onAdd }: { onAdd(b: { kind: "income" | "fixed"; name: string; amountCents: number; bucket: "needs" | "wants" | null }): void }) {
  const [kind, setKind] = useState<"income" | "fixed" | "fixed_wants">("fixed");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const cents = toCents(amount);
        if (!cents || !name.trim()) return;
        onAdd({ kind: kind === "income" ? "income" : "fixed", name: name.trim(), amountCents: cents, bucket: kind === "income" ? null : kind === "fixed_wants" ? "wants" : "needs" });
        setName("");
        setAmount("");
      }}
    >
      <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Tipo">
        <option value="income">Sueldo neto / ingreso</option>
        <option value="fixed">Fijo (necesidad)</option>
        <option value="fixed_wants">Fijo (capricho)</option>
      </select>
      <input placeholder="Nombre (p. ej. Alquiler)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nombre" required />
      <input inputMode="decimal" placeholder="€/mes" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Importe mensual" required />
      <button className="btn small">Guardar</button>
    </form>
  );
}

const RULE_FIELDS: { key: keyof PayRules; label: string; kind: "cents" | "time" | "mult" | "bool" }[] = [
  { key: "baseCents", label: "Sueldo base €/h", kind: "cents" },
  { key: "eveningSupplementCents", label: "Suplemento de tarde €/h", kind: "cents" },
  { key: "eveningFrom", label: "Tarde desde", kind: "time" },
  { key: "nightSupplementCents", label: "Suplemento de noche €/h", kind: "cents" },
  { key: "nightTo", label: "Noche hasta", kind: "time" },
  { key: "sundayHolidayMultiplier", label: "Domingo/festivo (x)", kind: "mult" },
  { key: "eveFrom", label: "Víspera desde", kind: "time" },
  { key: "eveMultiplier", label: "Víspera (x)", kind: "mult" },
  { key: "sundayNightConfirmed", label: "Noche en domingo confirmada", kind: "bool" },
];

function PayRulesCard(props: {
  sets: PayRuleSet[];
  options: MoneyData["options"];
  onSave(s: Omit<PayRuleSet, "id"> & { id?: string }): void;
  onDelete(id: string): void;
  onSaveSettings(p: Partial<Settings>): void;
}) {
  const [selected, setSelected] = useState(props.sets[props.sets.length - 1]?.id ?? "");
  const current = props.sets.find((s) => s.id === selected) ?? props.sets[props.sets.length - 1];
  const [draft, setDraft] = useState<PayRuleSet | null>(current ?? null);
  useEffect(() => setDraft(current ?? null), [current]);
  if (!draft) return null;

  const setRule = (key: keyof PayRules, value: unknown) => setDraft({ ...draft, rules: { ...draft.rules, [key]: value } });

  return (
    <div className="card">
      <h3>Reglas de pago</h3>
      <div className="actions-row">
        <select value={draft.id} onChange={(e) => setSelected(e.target.value)} aria-label="Tabla">
          {props.sets.map((s) => (
            <option key={s.id} value={s.id}>{s.validFrom} a {s.validTo ?? "sin fin"}</option>
          ))}
        </select>
        <button
          className="btn ghost small"
          onClick={() => {
            const last = props.sets[props.sets.length - 1]!;
            const from = last.validTo ? new Date(Date.parse(`${last.validTo}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : last.validFrom;
            props.onSave({ validFrom: from, validTo: null, rules: last.rules, note: "Tabla nueva" });
          }}
        >
          Nueva tabla
        </button>
      </div>
      <div className="row2 rules-grid">
        <label>Desde<input type="date" value={draft.validFrom} onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })} /></label>
        <label>Hasta<input type="date" value={draft.validTo ?? ""} onChange={(e) => setDraft({ ...draft, validTo: e.target.value || null })} /></label>
        {RULE_FIELDS.map((f) => (
          <label key={f.key} className={f.kind === "bool" ? "row" : ""}>
            {f.kind === "bool" ? (
              <>
                <input type="checkbox" checked={draft.rules[f.key] as boolean} onChange={(e) => setRule(f.key, e.target.checked)} />
                {f.label}
              </>
            ) : (
              <>
                {f.label}
                <input
                  type={f.kind === "time" ? "time" : "number"}
                  step={f.kind === "cents" ? 0.01 : f.kind === "mult" ? 0.05 : undefined}
                  value={f.kind === "cents" ? (draft.rules[f.key] as number) / 100 : String(draft.rules[f.key])}
                  onChange={(e) =>
                    setRule(f.key, f.kind === "cents" ? Math.round(Number(e.target.value) * 100) : f.kind === "mult" ? Number(e.target.value) : e.target.value)
                  }
                />
              </>
            )}
          </label>
        ))}
      </div>
      <div className="actions-row">
        <button className="btn small" onClick={() => props.onSave(draft)}>Guardar tabla</button>
        {props.sets.length > 1 && <button className="btn ghost small" onClick={() => props.onDelete(draft.id)}>Borrar tabla</button>}
      </div>
      <div className="row2">
        <label>
          Víspera de festivo
          <select value={props.options.eveMode} onChange={(e) => props.onSaveSettings({ payEveMode: e.target.value as Settings["payEveMode"] })}>
            <option value="probable">Probable: el 50 % sube también la base</option>
            <option value="minimum">Mínimo: solo sube el suplemento</option>
          </select>
        </label>
        <label>
          Turno que cruza a domingo o festivo
          <select value={props.options.midnightRule} onChange={(e) => props.onSaveSettings({ payMidnightRule: e.target.value as Settings["payMidnightRule"] })}>
            <option value="ask">Preguntar (no suponer)</option>
            <option value="calendar_day">Según el día del calendario</option>
            <option value="shift_start">Según el día de entrada</option>
          </select>
        </label>
      </div>
    </div>
  );
}
