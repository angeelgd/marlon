/** fetch falso que responde según la URL. Guarda las llamadas para comprobarlas. */
export interface FakeCall {
  url: string;
  init?: RequestInit;
  body?: string;
}

export function fakeFetch(routes: [RegExp, (call: FakeCall) => Response | Promise<Response>][]) {
  const calls: FakeCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, init, body: typeof init?.body === "string" ? init.body : undefined };
    calls.push(call);
    for (const [re, handler] of routes) if (re.test(url)) return handler(call);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Respuesta de Open-Meteo con tiempo constante para 3 días desde `date`. */
export function openMeteo(date: string, w: { temp: number; prob: number; precip?: number; wind?: number; code?: number }) {
  const days = [0, 1, 2].map((i) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const time = days.flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, "0")}:00`));
  const fill = (v: number) => time.map(() => v);
  return {
    hourly: {
      time,
      temperature_2m: fill(w.temp),
      precipitation_probability: fill(w.prob),
      precipitation: fill(w.precip ?? 0),
      weather_code: fill(w.code ?? 1),
      wind_speed_10m: fill(w.wind ?? 3),
    },
    daily: {
      time: days,
      temperature_2m_max: days.map(() => w.temp + 3),
      temperature_2m_min: days.map(() => w.temp - 3),
      weather_code: days.map(() => w.code ?? 1),
      precipitation_probability_max: days.map(() => w.prob),
      sunrise: days.map((d) => `${d}T08:05`),
      sunset: days.map((d) => `${d}T16:10`),
    },
  };
}
