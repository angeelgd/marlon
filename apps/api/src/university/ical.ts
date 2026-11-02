import { localToMs } from "../lib/time";

/**
 * Parser iCalendar (RFC 5545) pequeño, suficiente para el calendario de Lukkari:
 * VEVENT con DTSTART/DTEND/DURATION, TZID, fechas de día completo, STATUS,
 * RRULE sencillas (DAILY/WEEKLY con INTERVAL, COUNT, UNTIL y BYDAY), EXDATE
 * y RECURRENCE-ID para instancias modificadas.
 */

export interface IcalEvent {
  uid: string;
  /** Clave estable: el UID, y en las series además el inicio original de la instancia. */
  key: string;
  title: string;
  start: string; // ISO UTC
  end: string; // ISO UTC
  allDay: boolean;
  location: string | null;
  description: string | null;
  cancelled: boolean;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line: string): Prop | null {
  // El nombre y los parámetros acaban en el primer ":" que no está entre comillas.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

export function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Convierte un valor DATE o DATE-TIME en instante (ms). */
export function parseIcalDate(value: string, params: Record<string, string>, defaultTz: string): { ms: number; allDay: boolean } {
  const v = value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || params.VALUE === "DATE") {
    const m = d ?? /^(\d{4})(\d{2})(\d{2})/.exec(v)!;
    return { ms: localToMs(`${m[1]}-${m[2]}-${m[3]}T00:00`, defaultTz), allDay: true };
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!t) throw new Error(`Fecha iCal no válida: ${value}`);
  const [, y, mo, da, h, mi, s = "00", z] = t;
  if (z) return { ms: Date.UTC(+y!, +mo! - 1, +da!, +h!, +mi!, +s), allDay: false };
  const tz = params.TZID && isValidTimeZone(params.TZID) ? params.TZID : defaultTz;
  return { ms: localToMs(`${y}-${mo}-${da}T${h}:${mi}:${s}`, tz), allDay: false };
}

/** "PT1H30M", "P1D", "-PT15M" → ms. */
export function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) throw new Error(`Duración iCal no válida: ${v}`);
  const [, sign, w = "0", d = "0", h = "0", mi = "0", s = "0"] = m;
  const ms = ((+w * 7 + +d) * 86400 + +h * 3600 + +mi * 60 + +s) * 1000;
  return sign === "-" ? -ms : ms;
}

const BYDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

interface RawEvent {
  props: Map<string, Prop[]>;
}

function first(e: RawEvent, name: string): Prop | undefined {
  return e.props.get(name)?.[0];
}

/**
 * Expande una RRULE sencilla. Trabaja en hora "de pared" de la zona del evento
 * para que las clases no se muevan una hora con el cambio de horario.
 */
function expandRule(
  rule: string,
  startMs: number,
  tz: string,
  windowEnd: number,
  maxInstances = 400,
): number[] {
  const parts = Object.fromEntries(rule.split(";").map((p) => p.split("=") as [string, string]));
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY") return [startMs];
  const interval = Math.max(1, Number(parts.INTERVAL ?? 1));
  const count = parts.COUNT ? Number(parts.COUNT) : Infinity;
  const until = parts.UNTIL ? parseIcalDate(parts.UNTIL, {}, tz).ms : Infinity;
  const byDay = parts.BYDAY ? parts.BYDAY.split(",").map((d) => BYDAY[d.slice(-2)]).filter((d) => d !== undefined) : null;

  // Hora local del inicio, para repetirla cada día.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(startMs)).map((x) => [x.type, x.value]));
  const baseDate = Date.UTC(+p.year!, +p.month! - 1, +p.day!);
  const time = `${p.hour}:${p.minute}:${p.second}`;
  const startWeekday = new Date(baseDate).getUTCDay();
  const days = byDay && freq === "WEEKLY" ? byDay : [startWeekday];

  const out: number[] = [];
  for (let dayOffset = 0; out.length < Math.min(count, maxInstances); dayOffset++) {
    const dayMs = baseDate + dayOffset * 86_400_000;
    const date = new Date(dayMs);
    const weekIndex = Math.floor((dayOffset + ((startWeekday + 6) % 7)) / 7);
    const ok =
      freq === "DAILY"
        ? dayOffset % interval === 0
        : weekIndex % interval === 0 && days.includes(date.getUTCDay());
    if (!ok) continue;
    const iso = date.toISOString().slice(0, 10);
    const ms = localToMs(`${iso}T${time}`, tz);
    if (ms > until || ms > windowEnd) break;
    out.push(ms);
  }
  return out;
}

export interface ParseIcalOptions {
  defaultTz: string;
  /** Ventana de eventos que interesan (instantes en ms). */
  from: number;
  to: number;
}

export function parseIcal(text: string, opts: ParseIcalOptions): IcalEvent[] {
  const lines = unfold(text);
  const raw: RawEvent[] = [];
  let current: RawEvent | null = null;
  let depth = 0; // para ignorar VALARM dentro de VEVENT
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line === "BEGIN:VEVENT") {
      current = { props: new Map() };
      depth = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (line.startsWith("END:")) {
      if (line === "END:VEVENT" && depth === 0) {
        raw.push(current);
        current = null;
      } else depth--;
      continue;
    }
    if (depth > 0) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    const list = current.props.get(prop.name) ?? [];
    list.push(prop);
    current.props.set(prop.name, list);
  }

  // Instancias modificadas (RECURRENCE-ID) sustituyen a la generada por la RRULE.
  const overrides = new Map<string, RawEvent>();
  for (const e of raw) {
    const rid = first(e, "RECURRENCE-ID");
    const uid = first(e, "UID")?.value;
    if (rid && uid) overrides.set(`${uid}|${parseIcalDate(rid.value, rid.params, opts.defaultTz).ms}`, e);
  }

  const out: IcalEvent[] = [];
  const build = (
    e: RawEvent,
    uid: string,
    startMs: number,
    durationMs: number,
    allDay: boolean,
    originalMs: number | null,
  ) => {
    const endMs = startMs + durationMs;
    if (endMs <= opts.from || startMs >= opts.to) return;
    const status = first(e, "STATUS")?.value.toUpperCase();
    out.push({
      uid,
      // Evento suelto: el UID basta (si cambia de hora, se mueve). Serie: UID + inicio original.
      key: originalMs === null ? uid : `${uid}|${new Date(originalMs).toISOString()}`,
      title: unescapeText(first(e, "SUMMARY")?.value ?? "(sin título)"),
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      allDay,
      location: first(e, "LOCATION") ? unescapeText(first(e, "LOCATION")!.value) || null : null,
      description: first(e, "DESCRIPTION") ? unescapeText(first(e, "DESCRIPTION")!.value) || null : null,
      cancelled: status === "CANCELLED",
    });
  };

  for (const e of raw) {
    if (first(e, "RECURRENCE-ID")) continue;
    const uid = first(e, "UID")?.value;
    const dtstart = first(e, "DTSTART");
    if (!uid || !dtstart) continue;
    let start;
    try {
      start = parseIcalDate(dtstart.value, dtstart.params, opts.defaultTz);
    } catch {
      continue;
    }
    const dtend = first(e, "DTEND");
    const dur = first(e, "DURATION");
    let durationMs = start.allDay ? 86_400_000 : 0;
    try {
      if (dtend) durationMs = parseIcalDate(dtend.value, dtend.params, opts.defaultTz).ms - start.ms;
      else if (dur) durationMs = parseDuration(dur.value);
    } catch {
      continue;
    }
    const tz = dtstart.params.TZID && isValidTimeZone(dtstart.params.TZID) ? dtstart.params.TZID : opts.defaultTz;

    const rrule = first(e, "RRULE")?.value;
    const instances = rrule ? expandRule(rrule, start.ms, tz, opts.to) : [start.ms];
    const exdates = new Set<number>();
    for (const ex of e.props.get("EXDATE") ?? []) {
      for (const v of ex.value.split(",")) {
        try {
          exdates.add(parseIcalDate(v, ex.params, opts.defaultTz).ms);
        } catch {
          /* se ignora */
        }
      }
    }

    for (const ms of instances) {
      if (exdates.has(ms)) continue;
      const override = overrides.get(`${uid}|${ms}`);
      if (override) {
        const os = first(override, "DTSTART");
        const oe = first(override, "DTEND");
        if (!os) continue;
        const s = parseIcalDate(os.value, os.params, opts.defaultTz);
        const eMs = oe ? parseIcalDate(oe.value, oe.params, opts.defaultTz).ms : s.ms + durationMs;
        build(override, uid, s.ms, eMs - s.ms, s.allDay, ms);
      } else {
        build(e, uid, ms, durationMs, start.allDay, rrule ? ms : null);
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
