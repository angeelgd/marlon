import type { PayRules } from "@marlon/shared";
import { addDays } from "../lib/time";
import { dayInfo, isSundayOrHoliday, type DayType } from "./holidays";

/**
 * Calculador del sueldo bruto por turno.
 *
 * - Las horas son salida menos entrada (los descansos se pagan), en hora de reloj.
 * - El turno se parte por tramos en los límites de 06:00, 15:00 (víspera), 18:00 y 24:00.
 * - Domingos y festivos: base y suplementos x2. El suplemento de noche en domingo está
 *   "por confirmar" hasta que se marque como confirmado en la tabla.
 * - Víspera de festivo (no si cae en domingo): desde las 15:00, +50 %. Dos modos:
 *   "probable" (sube también la base) y "minimum" (solo el suplemento).
 * - Un turno que cruza la medianoche hacia un domingo o festivo no se supone:
 *   con la regla "ask" queda sin calcular y se ofrecen las dos opciones.
 *
 * Redondeo: todo se calcula en céntimos·minuto (exacto). El importe de un turno se
 * muestra con 3 decimales sin redondear (15:45 a 22:00 = 91,225 €); solo se redondea
 * el total del mes, a céntimos y "mitad hacia arriba", una única vez.
 */

export type EveMode = "probable" | "minimum";
export type MidnightRule = "ask" | "calendar_day" | "shift_start";

export interface ShiftTimes {
  date: string; // día de entrada
  start: string; // HH:MM
  end: string; // HH:MM
  endsNextDay: boolean;
}

export interface PaySegment {
  date: string;
  from: string; // HH:MM
  to: string; // HH:MM
  minutes: number;
  /** Céntimos por hora (puede tener decimales, p. ej. 355,5). */
  rateCents: number;
  label: string;
}

export type PayFlag = "eve_unconfirmed" | "sunday_night_unconfirmed" | "midnight_rule_needed";

export interface ShiftPay {
  date: string;
  minutes: number;
  /** Céntimos·minuto (exacto). null si falta la regla de medianoche. */
  centMinutes: number | null;
  segments: PaySegment[];
  flags: PayFlag[];
  /** Con la regla "ask": lo que saldría con cada opción. */
  options?: { calendar_day: number; shift_start: number };
  dayType: DayType;
  dayName: string | null;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

interface MinuteRate {
  rate: number;
  label: string;
  flags: PayFlag[];
}

/** Tarifa de un minuto a la hora de reloj `clock` (0-1439) en un día del tipo dado. */
function minuteRate(clock: number, type: DayType, rules: PayRules, eveMode: EveMode): MinuteRate {
  const evening = clock >= toMin(rules.eveningFrom);
  const night = clock < toMin(rules.nightTo);
  const supp = evening ? rules.eveningSupplementCents : night ? rules.nightSupplementCents : 0;
  const suppName = evening ? " + tarde" : night ? " + noche" : "";
  const flags: PayFlag[] = [];

  if (type === "sunday" || type === "holiday") {
    if (night && !rules.sundayNightConfirmed) flags.push("sunday_night_unconfirmed");
    return {
      rate: (rules.baseCents + supp) * rules.sundayHolidayMultiplier,
      label: `${type === "sunday" ? "domingo" : "festivo"}${suppName}`,
      flags,
    };
  }
  if (type === "eve" && clock >= toMin(rules.eveFrom)) {
    flags.push("eve_unconfirmed");
    const rate =
      eveMode === "probable"
        ? (rules.baseCents + supp) * rules.eveMultiplier
        : rules.baseCents + supp * rules.eveMultiplier;
    return { rate, label: `víspera (${eveMode === "probable" ? "probable" : "mínimo"})${suppName}`, flags };
  }
  return { rate: rules.baseCents + supp, label: `normal${suppName}`, flags };
}

function compute(shift: ShiftTimes, rules: PayRules, eveMode: EveMode, typeFor: (date: string) => DayType) {
  const start = toMin(shift.start);
  let end = toMin(shift.end);
  if (shift.endsNextDay || end <= start) end += 1440;
  const segments: PaySegment[] = [];
  const flags = new Set<PayFlag>();
  let centMinutes = 0;
  let cur: (PaySegment & { startAbs: number }) | null = null;

  for (let m = start; m < end; m++) {
    const date = m >= 1440 ? addDays(shift.date, 1) : shift.date;
    const clock = m % 1440;
    const r = minuteRate(clock, typeFor(date), rules, eveMode);
    r.flags.forEach((f) => flags.add(f));
    centMinutes += r.rate;
    if (cur && cur.rateCents === r.rate && cur.label === r.label && cur.date === date) {
      cur.minutes++;
      cur.to = fmt(m + 1);
    } else {
      if (cur) segments.push(stripAbs(cur));
      cur = { date, from: fmt(clock), to: fmt(m + 1), minutes: 1, rateCents: r.rate, label: r.label, startAbs: m };
    }
  }
  if (cur) segments.push(stripAbs(cur));
  return { minutes: end - start, centMinutes, segments, flags: [...flags] };
}

function stripAbs(s: PaySegment & { startAbs: number }): PaySegment {
  const { startAbs: _a, ...rest } = s;
  return rest;
}

export function calcShift(
  shift: ShiftTimes,
  rules: PayRules,
  opts: { eveMode: EveMode; midnightRule: MidnightRule },
): ShiftPay {
  const info = dayInfo(shift.date);
  const crossesIntoSpecial =
    (shift.endsNextDay || toMin(shift.end) <= toMin(shift.start)) &&
    toMin(shift.end) > 0 &&
    isSundayOrHoliday(addDays(shift.date, 1)) &&
    !isSundayOrHoliday(shift.date);

  const byCalendar = compute(shift, rules, opts.eveMode, (d) => dayInfo(d).type);
  if (!crossesIntoSpecial) {
    return { date: shift.date, ...byCalendar, dayType: info.type, dayName: info.name };
  }
  const byStart = compute(shift, rules, opts.eveMode, () => info.type);
  if (opts.midnightRule === "calendar_day") return { date: shift.date, ...byCalendar, dayType: info.type, dayName: info.name };
  if (opts.midnightRule === "shift_start") return { date: shift.date, ...byStart, dayType: info.type, dayName: info.name };
  return {
    date: shift.date,
    minutes: byCalendar.minutes,
    centMinutes: null,
    segments: byCalendar.segments,
    flags: [...new Set<PayFlag>([...byCalendar.flags, "midnight_rule_needed"])],
    options: { calendar_day: byCalendar.centMinutes, shift_start: byStart.centMinutes },
    dayType: info.type,
    dayName: info.name,
  };
}

/** Céntimos·minuto → euros con 3 decimales (sin redondear a céntimos). */
export const centMinutesToEuros = (cm: number) => Math.round((cm / 60 / 100) * 1000) / 1000;

/** Redondeo final a céntimos, mitad hacia arriba (con tolerancia de coma flotante). */
export const roundCents = (cm: number) => Math.floor(cm / 60 + 0.5 + 1e-9);
