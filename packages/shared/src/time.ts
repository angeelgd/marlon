/**
 * Utilidades de zona horaria sin dependencias (Intl está disponible en Workers).
 * Fechas locales como "YYYY-MM-DD", horas como "HH:MM", instantes en ISO UTC.
 */

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  weekday: number; // 0 = domingo
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function partsOf(ms: number, tz: string) {
  const out: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    y: Number(out.year),
    mo: Number(out.month),
    d: Number(out.day),
    h: Number(out.hour),
    mi: Number(out.minute),
    s: Number(out.second),
    wd: WEEKDAYS.indexOf(out.weekday ?? ""),
  };
}

/** Diferencia (ms) entre la hora local de `tz` y UTC en el instante dado. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = partsOf(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-05T18:00" (hora local de tz) → instante en ms. */
export function localToMs(local: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(local.trim());
  if (!m) throw new Error(`Fecha local no válida: ${local}`);
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const guess = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +s);
  let result = guess - tzOffsetMs(guess, tz);
  // Segunda pasada para los cambios de horario.
  const off2 = tzOffsetMs(result, tz);
  result = guess - off2;
  return result;
}

export function localToUtcIso(local: string, tz: string): string {
  return new Date(localToMs(local, tz)).toISOString();
}

/** Acepta ISO con zona ("Z" o "+02:00") o local sin zona (se interpreta en tz). */
export function anyToMs(value: string, tz: string): number {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value.trim())) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`Fecha no válida: ${value}`);
    return ms;
  }
  return localToMs(value, tz);
}

export function toLocalParts(ms: number, tz: string): LocalParts {
  const p = partsOf(ms, tz);
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}`, weekday: p.wd };
}

/** "2026-11-05T18:00" en hora local, para mostrar al modelo. */
export function toLocalIso(ms: number, tz: string): string {
  const p = toLocalParts(ms, tz);
  return `${p.date}T${p.time}`;
}

/** Suma días a una fecha "YYYY-MM-DD" (calendario puro, sin zona). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Día de la semana (0 = domingo) de una fecha "YYYY-MM-DD". */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

export function minutesToTime(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
