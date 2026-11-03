import type { Settings } from "@marlon/shared";
import { cached } from "./cache";

/**
 * Tiempo con Open-Meteo: gratis para uso no comercial y sin clave.
 * Las horas vienen en la zona horaria de los ajustes ("YYYY-MM-DDTHH:MM").
 */

export interface HourWeather {
  time: string;
  temperature: number;
  precipitationProbability: number;
  precipitation: number;
  windSpeed: number; // m/s
  code: number;
  description: string;
}

export interface DayWeather {
  date: string;
  max: number;
  min: number;
  code: number;
  description: string;
  precipitationProbabilityMax: number;
  sunrise: string;
  sunset: string;
}

export interface Forecast {
  city: string;
  hourly: HourWeather[];
  daily: DayWeather[];
}

const WMO: Record<number, string> = {
  0: "despejado",
  1: "casi despejado",
  2: "parcialmente nublado",
  3: "nublado",
  45: "niebla",
  48: "niebla con escarcha",
  51: "llovizna débil",
  53: "llovizna",
  55: "llovizna intensa",
  56: "llovizna helada",
  57: "llovizna helada intensa",
  61: "lluvia débil",
  63: "lluvia",
  65: "lluvia fuerte",
  66: "lluvia helada",
  67: "lluvia helada fuerte",
  71: "nieve débil",
  73: "nieve",
  75: "nieve fuerte",
  77: "granizo fino",
  80: "chubascos débiles",
  81: "chubascos",
  82: "chubascos fuertes",
  85: "chubascos de nieve",
  86: "chubascos de nieve fuertes",
  95: "tormenta",
  96: "tormenta con granizo",
  99: "tormenta fuerte con granizo",
};

export const describeWeather = (code: number) => WMO[code] ?? "tiempo variable";

interface OpenMeteoResponse {
  hourly?: Record<string, (number | string | null)[]>;
  daily?: Record<string, (number | string | null)[]>;
}

export function parseOpenMeteo(json: OpenMeteoResponse, city: string): Forecast {
  const h = json.hourly ?? {};
  const d = json.daily ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const hourly: HourWeather[] = (h.time ?? []).map((time, i) => {
    const code = num(h.weather_code?.[i]);
    return {
      time: String(time),
      temperature: num(h.temperature_2m?.[i]),
      precipitationProbability: num(h.precipitation_probability?.[i]),
      precipitation: num(h.precipitation?.[i]),
      windSpeed: num(h.wind_speed_10m?.[i]),
      code,
      description: describeWeather(code),
    };
  });
  const daily: DayWeather[] = (d.time ?? []).map((date, i) => {
    const code = num(d.weather_code?.[i]);
    return {
      date: String(date),
      max: num(d.temperature_2m_max?.[i]),
      min: num(d.temperature_2m_min?.[i]),
      code,
      description: describeWeather(code),
      precipitationProbabilityMax: num(d.precipitation_probability_max?.[i]),
      sunrise: String(d.sunrise?.[i] ?? ""),
      sunset: String(d.sunset?.[i] ?? ""),
    };
  });
  return { city, hourly, daily };
}

export async function getForecast(
  db: D1Database,
  settings: Pick<Settings, "latitude" | "longitude" | "timezone" | "cityName">,
  fetchImpl: typeof fetch = fetch,
): Promise<Forecast> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(settings.latitude),
    longitude: String(settings.longitude),
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset",
    timezone: settings.timezone,
    forecast_days: "3",
    wind_speed_unit: "ms",
  }).toString();
  return cached(db, `weather:${url.search}`, 60 * 60_000, async () => {
    const res = await fetchImpl(url.toString());
    if (!res.ok) throw new Error(`Open-Meteo respondió ${res.status}.`);
    return parseOpenMeteo((await res.json()) as OpenMeteoResponse, settings.cityName);
  });
}

/** Tiempo de la hora local que contiene `localIso` ("YYYY-MM-DDTHH:MM"). */
export function weatherAt(f: Forecast, localIso: string): HourWeather | null {
  const hour = `${localIso.slice(0, 13)}:00`;
  return f.hourly.find((h) => h.time === hour) ?? null;
}

export interface BikeVerdict {
  ok: boolean;
  reason: string;
}

/**
 * ¿Bici? Solo fuera del invierno (meses de los ajustes), con buen tiempo y
 * si el trayecto es corto.
 */
export function bikeVerdict(input: {
  month: number;
  fromMonth: number;
  toMonth: number;
  weather: HourWeather | null;
  bikeMinutes: number | null;
  maxMinutes: number;
}): BikeVerdict {
  const inSeason =
    input.fromMonth <= input.toMonth
      ? input.month >= input.fromMonth && input.month <= input.toMonth
      : input.month >= input.fromMonth || input.month <= input.toMonth;
  if (!inSeason) return { ok: false, reason: "En invierno, nada de bici." };
  if (input.bikeMinutes === null) return { ok: false, reason: "No sé cuánto se tarda en bici." };
  if (input.bikeMinutes > input.maxMinutes) return { ok: false, reason: `En bici son ${input.bikeMinutes} min, demasiado.` };
  const w = input.weather;
  if (!w) return { ok: false, reason: "No tengo la previsión para esa hora." };
  if (w.temperature < 5) return { ok: false, reason: `Hace frío (${Math.round(w.temperature)} °C).` };
  if (w.precipitationProbability >= 30 || w.precipitation >= 0.2) return { ok: false, reason: "Puede llover." };
  if (w.windSpeed >= 9) return { ok: false, reason: "Hace mucho viento." };
  if (w.code >= 45) return { ok: false, reason: `Hay ${w.description}.` };
  return { ok: true, reason: `Buen tiempo (${Math.round(w.temperature)} °C) y son ${input.bikeMinutes} min.` };
}
