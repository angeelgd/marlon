import { PayRulesSchema, type PayRuleSet, type Settings } from "@marlon/shared";
import { newId, nowIso } from "../lib/ids";
import { addDays, toLocalIso } from "../lib/time";
import { calcShift, centMinutesToEuros, roundCents, type PayFlag, type ShiftPay, type ShiftTimes } from "./pay";

/* ------------------------------------------------------------------ */
/* Tablas de sueldo con vigencia                                       */
/* ------------------------------------------------------------------ */

interface RuleRow {
  id: string;
  valid_from: string;
  valid_to: string | null;
  rules_json: string;
  note: string | null;
}

const toSet = (r: RuleRow): PayRuleSet => ({
  id: r.id,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  rules: PayRulesSchema.parse(JSON.parse(r.rules_json)),
  note: r.note,
});

export async function listRuleSets(db: D1Database): Promise<PayRuleSet[]> {
  const { results } = await db.prepare(`SELECT * FROM pay_rule_sets ORDER BY valid_from`).all<RuleRow>();
  return results.map(toSet);
}

export function ruleSetFor(sets: PayRuleSet[], date: string): PayRuleSet | null {
  return [...sets].reverse().find((s) => s.validFrom <= date && (!s.validTo || date <= s.validTo)) ?? null;
}

export async function saveRuleSet(db: D1Database, set: Omit<PayRuleSet, "id"> & { id?: string }): Promise<PayRuleSet> {
  const rules = PayRulesSchema.parse(set.rules);
  if (set.validTo && set.validTo < set.validFrom) throw new Error("La fecha final es anterior a la inicial.");
  const id = set.id ?? newId("rules");
  await db
    .prepare(
      `INSERT INTO pay_rule_sets (id, valid_from, valid_to, rules_json, note) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET valid_from = ?2, valid_to = ?3, rules_json = ?4, note = ?5`,
    )
    .bind(id, set.validFrom, set.validTo, JSON.stringify(rules), set.note)
    .run();
  return { id, validFrom: set.validFrom, validTo: set.validTo, rules, note: set.note };
}

export async function deleteRuleSet(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM pay_rule_sets WHERE id = ?`).bind(id).run();
}

/** La tabla que caduca pronto sin otra que la siga: hay que avisar un mes antes. */
export function expiringRuleSet(sets: PayRuleSet[], today: string): PayRuleSet | null {
  for (const s of sets) {
    if (!s.validTo) continue;
    const followed = sets.some((o) => o.id !== s.id && o.validFrom <= addDays(s.validTo!, 1) && (!o.validTo || o.validTo > s.validTo!));
    if (!followed && today >= addDays(s.validTo, -30) && today <= s.validTo) return s;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Horas reales                                                        */
/* ------------------------------------------------------------------ */

export interface ActualShiftInput {
  date: string;
  start?: string | null;
  end?: string | null;
  dayOff?: boolean;
  note?: string | null;
}

interface PlannedRow {
  date: string;
  start_time: string;
  end_time: string;
  ends_next_day: number;
}
interface ActualRow {
  date: string;
  start_time: string | null;
  end_time: string | null;
  ends_next_day: number;
  day_off: number;
  note: string | null;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Guarda las horas reales de un día. Lo que no se diga se toma del horario
 * planificado ("hoy salí a las 21:00" cambia solo la salida). No toca lo planificado.
 */
export async function logActualShift(db: D1Database, input: ActualShiftInput) {
  const planned = await db.prepare(`SELECT * FROM planned_shifts WHERE date = ?`).bind(input.date).first<PlannedRow>();
  const prev = await db.prepare(`SELECT * FROM actual_shifts WHERE date = ?`).bind(input.date).first<ActualRow>();
  if (input.dayOff) {
    await db
      .prepare(
        `INSERT INTO actual_shifts (date, start_time, end_time, ends_next_day, day_off, note, updated_at) VALUES (?1, NULL, NULL, 0, 1, ?2, ?3)
         ON CONFLICT(date) DO UPDATE SET start_time = NULL, end_time = NULL, ends_next_day = 0, day_off = 1, note = ?2, updated_at = ?3`,
      )
      .bind(input.date, input.note ?? null, nowIso())
      .run();
    return { date: input.date, dayOff: true, planned: planned ? `${planned.start_time}-${planned.end_time}` : null };
  }
  const start = input.start ?? prev?.start_time ?? planned?.start_time;
  const end = input.end ?? prev?.end_time ?? planned?.end_time;
  if (!start || !end) {
    throw new Error(`No hay turno planificado el ${input.date}: necesito la hora de entrada y la de salida.`);
  }
  if (start === end) throw new Error("La entrada y la salida son iguales.");
  const endsNextDay = toMin(end) <= toMin(start);
  await db
    .prepare(
      `INSERT INTO actual_shifts (date, start_time, end_time, ends_next_day, day_off, note, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
       ON CONFLICT(date) DO UPDATE SET start_time = ?2, end_time = ?3, ends_next_day = ?4, day_off = 0, note = ?5, updated_at = ?6`,
    )
    .bind(input.date, start, end, endsNextDay ? 1 : 0, input.note ?? prev?.note ?? null, nowIso())
    .run();
  return {
    date: input.date,
    start,
    end,
    endsNextDay,
    planned: planned ? `${planned.start_time}-${planned.end_time}` : null,
  };
}

export async function clearActualShift(db: D1Database, date: string): Promise<void> {
  await db.prepare(`DELETE FROM actual_shifts WHERE date = ?`).bind(date).run();
}

/* ------------------------------------------------------------------ */
/* Resumen del mes                                                     */
/* ------------------------------------------------------------------ */

export interface DayComparison {
  date: string;
  planned: string | null; // "15:45-22:00"
  actual: string | null; // null = no fue
  plannedEuros: number | null;
  actualEuros: number | null;
  /** La hora real es la planificada porque no se dijo nada. */
  assumed: boolean;
  dayName: string | null;
  flags: PayFlag[];
}

export interface MonthPay {
  month: string;
  plannedCents: number;
  actualCents: number;
  differenceCents: number;
  plannedHours: number;
  actualHours: number;
  days: DayComparison[];
  /** Días en que lo real difiere de lo planificado (para confirmarlos). */
  differingDays: DayComparison[];
  /** Turnos sin calcular porque falta la regla de medianoche. */
  unresolved: { date: string; calendarDayEuros: number; shiftStartEuros: number }[];
  /** Importes por confirmar (víspera, noche en domingo). */
  toConfirm: { date: string; reason: string }[];
  missingRules: string[];
  disclaimer: string;
}

const REASON: Record<PayFlag, string> = {
  eve_unconfirmed: "víspera de festivo: importe por confirmar",
  sunday_night_unconfirmed: "suplemento de noche en domingo o festivo por confirmar",
  midnight_rule_needed: "cruza la medianoche hacia domingo o festivo: falta la regla",
};

export async function monthPay(db: D1Database, month: string, settings: Settings): Promise<MonthPay> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Mes no válido (YYYY-MM).");
  const from = `${month}-01`;
  const to = addDays(`${nextMonth(month)}-01`, -1);
  const [{ results: planned }, { results: actual }, sets] = await Promise.all([
    db.prepare(`SELECT * FROM planned_shifts WHERE date BETWEEN ? AND ? ORDER BY date`).bind(from, to).all<PlannedRow>(),
    db.prepare(`SELECT * FROM actual_shifts WHERE date BETWEEN ? AND ? ORDER BY date`).bind(from, to).all<ActualRow>(),
    listRuleSets(db),
  ]);
  const plannedBy = new Map(planned.map((p) => [p.date, p]));
  const actualBy = new Map(actual.map((a) => [a.date, a]));
  const dates = [...new Set([...plannedBy.keys(), ...actualBy.keys()])].sort();
  const opts = { eveMode: settings.payEveMode, midnightRule: settings.payMidnightRule };

  const out: MonthPay = {
    month,
    plannedCents: 0,
    actualCents: 0,
    differenceCents: 0,
    plannedHours: 0,
    actualHours: 0,
    days: [],
    differingDays: [],
    unresolved: [],
    toConfirm: [],
    missingRules: [],
    disclaimer:
      "Estimación bruta (antes de impuestos y retenciones). Contrástala siempre con la nómina.",
  };
  let plannedCm = 0;
  let actualCm = 0;
  let plannedMin = 0;
  let actualMin = 0;

  for (const date of dates) {
    const set = ruleSetFor(sets, date);
    if (!set) {
      out.missingRules.push(date);
      continue;
    }
    const p = plannedBy.get(date);
    const a = actualBy.get(date);
    const pTimes: ShiftTimes | null = p ? { date, start: p.start_time, end: p.end_time, endsNextDay: p.ends_next_day === 1 } : null;
    const aTimes: ShiftTimes | null = a
      ? a.day_off || !a.start_time || !a.end_time
        ? null
        : { date, start: a.start_time, end: a.end_time, endsNextDay: a.ends_next_day === 1 }
      : pTimes;
    const pPay: ShiftPay | null = pTimes ? calcShift(pTimes, set.rules, opts) : null;
    const aPay: ShiftPay | null = aTimes ? calcShift(aTimes, set.rules, opts) : null;

    if (pPay?.centMinutes != null) {
      plannedCm += pPay.centMinutes;
      plannedMin += pPay.minutes;
    }
    if (aPay?.centMinutes != null) {
      actualCm += aPay.centMinutes;
      actualMin += aPay.minutes;
    }
    if (aPay?.options && aPay.centMinutes === null) {
      out.unresolved.push({
        date,
        calendarDayEuros: centMinutesToEuros(aPay.options.calendar_day),
        shiftStartEuros: centMinutesToEuros(aPay.options.shift_start),
      });
    }
    const flags = [...new Set([...(pPay?.flags ?? []), ...(aPay?.flags ?? [])])];
    for (const f of flags) if (f !== "midnight_rule_needed") out.toConfirm.push({ date, reason: REASON[f] });

    const label = (t: ShiftTimes | null) => (t ? `${t.start}-${t.end}` : null);
    const day: DayComparison = {
      date,
      planned: label(pTimes),
      actual: label(aTimes),
      plannedEuros: pPay?.centMinutes != null ? centMinutesToEuros(pPay.centMinutes) : null,
      actualEuros: aPay?.centMinutes != null ? centMinutesToEuros(aPay.centMinutes) : null,
      assumed: !a,
      dayName: (pPay ?? aPay)?.dayName ?? null,
      flags,
    };
    out.days.push(day);
    if (label(pTimes) !== label(aTimes)) out.differingDays.push(day);
  }

  out.plannedCents = roundCents(plannedCm);
  out.actualCents = roundCents(actualCm);
  out.differenceCents = out.actualCents - out.plannedCents;
  out.plannedHours = Math.round((plannedMin / 60) * 100) / 100;
  out.actualHours = Math.round((actualMin / 60) * 100) / 100;
  return out;
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
}

export const currentMonth = (now: number, tz: string) => toLocalIso(now, tz).slice(0, 7);
