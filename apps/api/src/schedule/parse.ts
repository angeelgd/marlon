import type { ScheduleIssue } from "@marlon/shared";
import { addDays, weekdayOf } from "../lib/time";

/**
 * Parser determinista del horario de trabajo.
 *
 * El modelo de visión solo transcribe las celdas tal como aparecen en la foto
 * ("Oct-19", "Sun", "15.45", "22.00", "6,25"). Aquí se interpretan y validan.
 */

export interface RawRow {
  date: string | null;
  weekday: string | null;
  start: string | null;
  end: string | null;
  hours: string | null;
}

export interface ParsedShift {
  date: string; // YYYY-MM-DD, día de entrada
  start: string; // HH:MM
  end: string; // HH:MM
  endsNextDay: boolean;
  /** Horas según la columna de la hoja (o calculadas si no venía). */
  hours: number;
  /** true si hay alguna incidencia asociada a esta fila. */
  flagged: boolean;
}

export interface ParseResult {
  shifts: ParsedShift[];
  daysOff: string[];
  issues: ScheduleIssue[];
}

const strip = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const MONTHS: Record<string, number> = {
  // inglés
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // español
  ene: 1, abr: 4, ago: 8, dic: 12,
  // finés (abreviaturas habituales)
  tam: 1, hel: 2, maa: 3, huh: 4, tou: 5, kes: 6, hei: 7, elo: 8, syy: 9, lok: 10, jou: 12,
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6,
  su: 0, ma: 1, ti: 2, ke: 3, to: 4, pe: 5, la: 6,
};

export function parseWeekday(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = strip(raw).replace(/[^a-z]/g, "");
  if (!s) return null;
  if (s.length >= 3) {
    const v = WEEKDAYS[s.slice(0, 3)];
    if (v !== undefined) return v;
  }
  if (s.length === 2) {
    const v = WEEKDAYS[s];
    if (v !== undefined) return v;
  }
  return null;
}

function monthFromName(name: string): number | null {
  const s = strip(name).replace(/[^a-z]/g, "").slice(0, 3);
  if (!s) return null;
  // "mar" en finés (marraskuu) choca con marzo; damos prioridad a inglés/español.
  const v = MONTHS[s];
  return v ?? null;
}

/** Devuelve [mes, día] o null. Acepta "Oct-19", "19-Oct", "Oct 19", "19.10", "19/10". */
export function parseMonthDay(raw: string | null | undefined): [number, number] | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = /^([A-Za-zÀ-ÿ]{3,})\.?[\s\-/.]*(\d{1,2})$/.exec(s);
  if (m) {
    const mo = monthFromName(m[1]!);
    const d = Number(m[2]);
    return mo && d >= 1 && d <= 31 ? [mo, d] : null;
  }
  m = /^(\d{1,2})[\s\-/.]*([A-Za-zÀ-ÿ]{3,})\.?$/.exec(s);
  if (m) {
    const mo = monthFromName(m[2]!);
    const d = Number(m[1]);
    return mo && d >= 1 && d <= 31 ? [mo, d] : null;
  }
  m = /^(\d{1,2})[./](\d{1,2})\.?$/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? [mo, d] : null;
  }
  return null;
}

function validDate(y: number, mo: number, d: number): string | null {
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Infiere el año más cercano a `today`. Si se conoce el día de la semana,
 * se usa para desempatar o confirmar.
 */
export function inferDate(
  month: number,
  day: number,
  weekday: number | null,
  today: string,
): { date: string | null; weekdayMatches: boolean | null } {
  const year = Number(today.slice(0, 4));
  const candidates = [year - 1, year, year + 1]
    .map((y) => validDate(y, month, day))
    .filter((d): d is string => d !== null)
    .sort((a, b) => daysBetween(a, today) - daysBetween(b, today));
  if (candidates.length === 0) return { date: null, weekdayMatches: null };
  if (weekday === null) return { date: candidates[0]!, weekdayMatches: null };
  const matching = candidates.find((c) => weekdayOf(c) === weekday);
  if (matching && daysBetween(matching, today) <= 200) return { date: matching, weekdayMatches: true };
  return { date: candidates[0]!, weekdayMatches: false };
}

/** "15.45" | "15:45" | "15" | "9.00" → "15:45". "24.00" → "24:00". */
export function parseTime(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{1,2})(?:[.:,h](\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** "6,25" → 6.25. Vacío → null. */
export function parseHours(raw: string | null | undefined): number | null | "invalid" {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s || s === "-") return null;
  const m = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return "invalid";
  return Number(`${m[1]}.${m[2] ?? "0"}`);
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Tolerancia en minutos al comparar salida menos entrada con la columna de horas. */
const TOLERANCE_MIN = 1;

export function parseSchedule(rows: RawRow[], today: string): ParseResult {
  const shifts: ParsedShift[] = [];
  const daysOff: string[] = [];
  const issues: ScheduleIssue[] = [];
  const seen = new Set<string>();

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const md = parseMonthDay(row.date);
    if (!md) {
      // Fila totalmente vacía (p. ej. separador de semana): se ignora.
      if (!row.date && !row.start && !row.end && !row.hours) return;
      issues.push({ row: rowNo, kind: "unreadable_date", message: `No entiendo la fecha "${row.date ?? ""}".` });
      return;
    }
    const wd = parseWeekday(row.weekday);
    const { date, weekdayMatches } = inferDate(md[0], md[1], wd, today);
    if (!date) {
      issues.push({ row: rowNo, kind: "unreadable_date", message: `La fecha "${row.date}" no existe.` });
      return;
    }
    let flagged = false;
    if (weekdayMatches === false) {
      flagged = true;
      issues.push({
        row: rowNo,
        kind: "weekday_mismatch",
        date,
        message: `"${row.date}" aparece como ${row.weekday}, pero no cuadra con ningún año cercano.`,
      });
    }
    if (seen.has(date)) {
      issues.push({ row: rowNo, kind: "duplicate_date", date, message: `La fecha ${date} aparece dos veces.` });
      return;
    }
    seen.add(date);

    const hours = parseHours(row.hours);
    const startRaw = row.start?.trim() || null;
    const endRaw = row.end?.trim() || null;

    if (!startRaw && !endRaw) {
      if (hours === null || hours === 0) {
        daysOff.push(date);
      } else {
        issues.push({
          row: rowNo,
          kind: "incomplete",
          date,
          message: `El ${date} no tiene horas de entrada y salida, pero marca ${row.hours} horas.`,
        });
      }
      return;
    }
    if (!startRaw || !endRaw) {
      issues.push({ row: rowNo, kind: "incomplete", date, message: `Al ${date} le falta la hora de entrada o de salida.` });
      return;
    }
    const start = parseTime(startRaw);
    const end = parseTime(endRaw);
    if (!start || !end || hours === "invalid") {
      issues.push({
        row: rowNo,
        kind: "unreadable_time",
        date,
        message: `No entiendo las horas del ${date}: "${startRaw}" a "${endRaw}" (${row.hours ?? "sin total"}).`,
      });
      return;
    }
    const startMin = toMin(start);
    let endMin = toMin(end);
    if (endMin === startMin) {
      issues.push({ row: rowNo, kind: "unreadable_time", date, message: `La entrada y la salida del ${date} son iguales.` });
      return;
    }
    const endsNextDay = endMin < startMin || endMin === 24 * 60;
    if (endMin < startMin) endMin += 24 * 60;
    const duration = endMin - startMin;

    if (hours !== null && Math.abs(duration - Math.round(hours * 60)) > TOLERANCE_MIN) {
      flagged = true;
      const h = Math.floor(duration / 60);
      const m = duration % 60;
      issues.push({
        row: rowNo,
        kind: "hours_mismatch",
        date,
        message: `El ${date} leo de ${start} a ${end} (${h} h ${m} min), pero la hoja dice ${row.hours} horas.`,
      });
    }

    const normEnd = end === "24:00" ? "00:00" : end;
    shifts.push({
      date,
      start,
      end: normEnd,
      endsNextDay,
      hours: hours ?? Math.round((duration / 60) * 100) / 100,
      flagged,
    });
  });

  shifts.sort((a, b) => a.date.localeCompare(b.date));
  daysOff.sort();
  return { shifts, daysOff, issues };
}

/** Rango de fechas cubierto por la foto (incluye días libres). */
export function coveredRange(result: ParseResult): { from: string; to: string } | null {
  const dates = [...result.shifts.map((s) => s.date), ...result.daysOff].sort();
  if (dates.length === 0) return null;
  return { from: dates[0]!, to: dates[dates.length - 1]! };
}

/** Fecha local del final de un turno. */
export function shiftEndDate(s: Pick<ParsedShift, "date" | "endsNextDay">): string {
  return s.endsNextDay ? addDays(s.date, 1) : s.date;
}
