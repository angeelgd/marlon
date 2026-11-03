import type { CalendarEvent, Settings } from "@marlon/shared";
import { toLocalIso, toLocalParts } from "../lib/time";
import { cached } from "./cache";
import { bikeVerdict, getForecast, weatherAt, type BikeVerdict } from "./weather";

/**
 * Rutas con Google Maps Platform, Routes API (computeRoutes).
 * - Transporte público: travelMode TRANSIT con arrivalTime (llegar a tiempo).
 * - Bici: travelMode BICYCLE, solo para decidir si es una opción.
 * Las respuestas se guardan en caché para no gastar cuota.
 */

const ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const TRANSIT_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.transitDetails",
].join(",");

export interface RouteStep {
  mode: "WALK" | "TRANSIT" | "BICYCLE" | "OTHER";
  minutes: number;
  line?: string;
  headsign?: string;
  fromStop?: string;
  toStop?: string;
  /** Salida del vehículo (instante ISO). */
  departure?: string;
}

export interface TransitRoute {
  minutes: number;
  /** Hora a la que salir de casa (ms). */
  leaveAt: number;
  arriveAt: number;
  steps: RouteStep[];
  summary: string;
}

interface ApiStep {
  travelMode?: string;
  staticDuration?: string;
  transitDetails?: {
    headsign?: string;
    stopDetails?: {
      departureStop?: { name?: string };
      arrivalStop?: { name?: string };
      departureTime?: string;
      arrivalTime?: string;
    };
    transitLine?: { nameShort?: string; name?: string };
  };
}

interface ApiResponse {
  routes?: { duration?: string; legs?: { steps?: ApiStep[] }[] }[];
}

const seconds = (d?: string) => (d ? Number(d.replace(/s$/, "")) || 0 : 0);

/**
 * Interpreta la respuesta de computeRoutes. La hora de salida es la del primer
 * vehículo menos lo que se camina antes; si todo es a pie, llegada menos duración.
 */
export function parseTransitResponse(json: ApiResponse, arriveBy: number): TransitRoute | null {
  const route = json.routes?.[0];
  if (!route) return null;
  const apiSteps = route.legs?.flatMap((l) => l.steps ?? []) ?? [];
  const steps: RouteStep[] = apiSteps.map((s) => {
    const mode = s.travelMode === "WALK" || s.travelMode === "TRANSIT" || s.travelMode === "BICYCLE" ? s.travelMode : "OTHER";
    const t = s.transitDetails;
    return {
      mode,
      minutes: Math.round(seconds(s.staticDuration) / 60),
      line: t?.transitLine?.nameShort ?? t?.transitLine?.name,
      headsign: t?.headsign,
      fromStop: t?.stopDetails?.departureStop?.name,
      toStop: t?.stopDetails?.arrivalStop?.name,
      departure: t?.stopDetails?.departureTime,
    };
  });
  // Pasos a pie seguidos se juntan para que el resumen sea legible.
  const merged: RouteStep[] = [];
  for (const s of steps) {
    const last = merged[merged.length - 1];
    if (last && last.mode === "WALK" && s.mode === "WALK") last.minutes += s.minutes;
    else merged.push({ ...s });
  }

  const totalMin = Math.round(seconds(route.duration) / 60);
  const firstTransit = apiSteps.findIndex((s) => s.travelMode === "TRANSIT" && s.transitDetails?.stopDetails?.departureTime);
  let leaveAt: number;
  let arriveAt: number;
  if (firstTransit >= 0) {
    const walkBefore = apiSteps.slice(0, firstTransit).reduce((acc, s) => acc + seconds(s.staticDuration), 0);
    leaveAt = Date.parse(apiSteps[firstTransit]!.transitDetails!.stopDetails!.departureTime!) - walkBefore * 1000;
    arriveAt = leaveAt + totalMin * 60_000;
  } else {
    arriveAt = arriveBy;
    leaveAt = arriveBy - totalMin * 60_000;
  }
  const summary = merged
    .map((s) =>
      s.mode === "TRANSIT"
        ? `bus ${s.line ?? ""}${s.headsign ? ` hacia ${s.headsign}` : ""}${s.fromStop ? ` desde ${s.fromStop}` : ""}`.trim()
        : s.mode === "WALK"
          ? `${s.minutes} min andando`
          : `${s.minutes} min`,
    )
    .join(", ");
  return { minutes: totalMin, leaveAt, arriveAt, steps: merged, summary };
}

export async function computeTransitRoute(opts: {
  db: D1Database;
  apiKey: string;
  origin: string;
  destination: string;
  arriveBy: number;
  fetchImpl?: typeof fetch;
}): Promise<TransitRoute | null> {
  // Las llegadas se agrupan en franjas de 5 minutos para aprovechar la caché.
  const bucket = Math.floor(opts.arriveBy / 300_000) * 300_000;
  const key = `route:transit:${opts.origin}|${opts.destination}|${bucket}`;
  return cached(opts.db, key, 12 * 60 * 60_000, async () => {
    const res = await (opts.fetchImpl ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": opts.apiKey,
        "X-Goog-FieldMask": TRANSIT_MASK,
      },
      body: JSON.stringify({
        origin: { address: opts.origin },
        destination: { address: opts.destination },
        travelMode: "TRANSIT",
        arrivalTime: new Date(bucket).toISOString(),
        languageCode: "es",
        units: "METRIC",
      }),
    });
    if (!res.ok) throw new Error(`Routes API respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return parseTransitResponse((await res.json()) as ApiResponse, bucket);
  });
}

export async function computeBikeMinutes(opts: {
  db: D1Database;
  apiKey: string;
  origin: string;
  destination: string;
  fetchImpl?: typeof fetch;
}): Promise<number | null> {
  // El trayecto en bici apenas cambia: caché de una semana.
  return cached(opts.db, `route:bike:${opts.origin}|${opts.destination}`, 7 * 86_400_000, async () => {
    const res = await (opts.fetchImpl ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": opts.apiKey, "X-Goog-FieldMask": "routes.duration" },
      body: JSON.stringify({ origin: { address: opts.origin }, destination: { address: opts.destination }, travelMode: "BICYCLE" }),
    });
    if (!res.ok) throw new Error(`Routes API respondió ${res.status}.`);
    const json = (await res.json()) as ApiResponse;
    const d = json.routes?.[0]?.duration;
    return d ? Math.round(seconds(d) / 60) : null;
  });
}

/* ------------------------------------------------------------------ */
/* Hora de salida para un evento                                       */
/* ------------------------------------------------------------------ */

export interface Departure {
  eventId: string;
  title: string;
  eventStart: string; // local
  destination: string | null;
  /** Hora de salida (local). */
  leaveAt: string;
  arriveBy: string;
  source: "routes_api" | "estimate";
  minutes: number;
  summary: string;
  bike: BikeVerdict | null;
  note?: string;
}

/** Dirección de destino según el tipo de evento (siempre desde los ajustes). */
export function destinationFor(ev: CalendarEvent, s: Settings): string | null {
  if (ev.kind === "work_planned") return s.workLocation || null;
  if (ev.kind === "university") return s.universityAddress || null;
  if (ev.kind === "gym") return s.gymAddress || null;
  return ev.location || null;
}

export async function planDeparture(opts: {
  db: D1Database;
  event: CalendarEvent;
  settings: Settings;
  mapsKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<Departure> {
  const { event, settings: s } = opts;
  const tz = s.timezone;
  const start = Date.parse(event.start);
  const arriveBy = start - s.arrivalMarginMin * 60_000;
  const destination = destinationFor(event, s);
  const base = {
    eventId: event.id,
    title: event.title,
    eventStart: toLocalIso(start, tz),
    destination,
    arriveBy: toLocalIso(arriveBy, tz),
  };

  const estimate = (note: string): Departure => ({
    ...base,
    leaveAt: toLocalIso(arriveBy - s.defaultCommuteMin * 60_000, tz),
    source: "estimate",
    minutes: s.defaultCommuteMin,
    summary: `unos ${s.defaultCommuteMin} min (estimado)`,
    bike: null,
    note,
  });

  if (!destination || !s.homeAddress) return estimate("Faltan direcciones en los ajustes.");
  if (!opts.mapsKey) return estimate("Sin clave de Google Maps, uso el trayecto estimado.");

  let route: TransitRoute | null;
  try {
    route = await computeTransitRoute({
      db: opts.db,
      apiKey: opts.mapsKey,
      origin: s.homeAddress,
      destination,
      arriveBy,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    return estimate(`No pude calcular la ruta: ${(err as Error).message}`);
  }
  if (!route) return estimate("Google no encontró ruta en transporte público.");

  // ¿Bici? Solo si toca por temporada; así no se gasta cuota en invierno.
  let bike: BikeVerdict | null = null;
  const month = Number(toLocalParts(start, tz).date.slice(5, 7));
  const inSeason = s.bikeFromMonth <= s.bikeToMonth ? month >= s.bikeFromMonth && month <= s.bikeToMonth : month >= s.bikeFromMonth || month <= s.bikeToMonth;
  if (!inSeason) {
    bike = { ok: false, reason: "En invierno, nada de bici." };
  } else {
    try {
      const [minutes, forecast] = await Promise.all([
        computeBikeMinutes({ db: opts.db, apiKey: opts.mapsKey, origin: s.homeAddress, destination, fetchImpl: opts.fetchImpl }),
        getForecast(opts.db, s, opts.fetchImpl),
      ]);
      bike = bikeVerdict({
        month,
        fromMonth: s.bikeFromMonth,
        toMonth: s.bikeToMonth,
        weather: weatherAt(forecast, toLocalIso(arriveBy, tz)),
        bikeMinutes: minutes,
        maxMinutes: s.bikeMaxMin,
      });
    } catch {
      bike = null;
    }
  }

  return {
    ...base,
    leaveAt: toLocalIso(route.leaveAt, tz),
    source: "routes_api",
    minutes: route.minutes,
    summary: route.summary,
    bike,
  };
}
