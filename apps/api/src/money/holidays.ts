import { addDays, weekdayOf } from "../lib/time";

/**
 * Festivos oficiales de Finlandia y las vísperas que cuentan para el sueldo.
 * Se calculan aquí (Pascua con el algoritmo gregoriano anónimo) para no
 * depender de una API externa: son reglas fijas desde hace décadas.
 */

/** Domingo de Pascua (calendario gregoriano). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Primer día de la semana `weekday` entre `from` y `from + 6`. */
function weekdayBetween(year: number, monthDayFrom: string, weekday: number): string {
  let d = `${year}-${monthDayFrom}`;
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  return d;
}

const cache = new Map<number, { holidays: Map<string, string>; eves: Map<string, string> }>();

export function finnishCalendar(year: number) {
  const hit = cache.get(year);
  if (hit) return hit;
  const easter = easterSunday(year);
  const holidays = new Map<string, string>([
    [`${year}-01-01`, "Año Nuevo"],
    [`${year}-01-06`, "Epifanía"],
    [addDays(easter, -2), "Viernes Santo"],
    [easter, "Domingo de Pascua"],
    [addDays(easter, 1), "Lunes de Pascua"],
    [`${year}-05-01`, "Vappu (1 de mayo)"],
    [addDays(easter, 39), "Ascensión"],
    [addDays(easter, 49), "Pentecostés"],
    [weekdayBetween(year, "06-20", 6), "San Juan (Juhannuspäivä)"],
    [weekdayBetween(year, "10-31", 6), "Todos los Santos"],
    [`${year}-12-06`, "Día de la Independencia"],
    [`${year}-12-25`, "Navidad"],
    [`${year}-12-26`, "San Esteban"],
  ]);
  const eves = new Map<string, string>([
    [addDays(easter, -1), "Sábado Santo"],
    [`${year}-04-30`, "Víspera de Vappu"],
    [weekdayBetween(year, "06-19", 5), "Víspera de San Juan (Juhannusaatto)"],
    [`${year}-12-24`, "Nochebuena"],
    [`${year}-12-31`, "Nochevieja"],
  ]);
  const out = { holidays, eves };
  cache.set(year, out);
  return out;
}

export type DayType = "normal" | "sunday" | "holiday" | "eve";

export interface DayInfo {
  type: DayType;
  name: string | null;
}

/** Domingo y festivo pagan igual; una víspera que cae en domingo es domingo. */
export function dayInfo(date: string): DayInfo {
  const cal = finnishCalendar(Number(date.slice(0, 4)));
  const holiday = cal.holidays.get(date);
  if (holiday) return { type: "holiday", name: holiday };
  if (weekdayOf(date) === 0) return { type: "sunday", name: null };
  const eve = cal.eves.get(date);
  if (eve) return { type: "eve", name: eve };
  return { type: "normal", name: null };
}

export const isSundayOrHoliday = (d: string) => {
  const t = dayInfo(d).type;
  return t === "sunday" || t === "holiday";
};
