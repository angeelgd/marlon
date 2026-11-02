import { DEFAULT_SETTINGS, type CalendarEvent, type Settings } from "@marlon/shared";
import { describe, expect, it } from "vitest";
import { parseTransitResponse, planDeparture } from "../src/integrations/routes";
import { bikeVerdict, getForecast, parseOpenMeteo, weatherAt } from "../src/integrations/weather";
import { localToUtcIso } from "../src/lib/time";
import { fakeFetch, json, openMeteo } from "./fakes";
import { testEnv, TZ } from "./helpers";

const S: Settings = {
  ...DEFAULT_SETTINGS,
  homeAddress: "Casa 1, Turku",
  workLocation: "Trabajo 2, Turku",
  universityAddress: "Uni 3, Turku",
};
const at = (s: string) => localToUtcIso(s, TZ);

const transitResponse = (departure: string) => ({
  routes: [
    {
      duration: "1500s",
      legs: [
        {
          steps: [
            { travelMode: "WALK", staticDuration: "120s" },
            { travelMode: "WALK", staticDuration: "180s" },
            {
              travelMode: "TRANSIT",
              staticDuration: "900s",
              transitDetails: {
                headsign: "Kauppatori",
                transitLine: { nameShort: "18" },
                stopDetails: { departureStop: { name: "Ylioppilaskylä" }, arrivalStop: { name: "Kauppatori" }, departureTime: departure },
              },
            },
            { travelMode: "WALK", staticDuration: "300s" },
          ],
        },
      ],
    },
  ],
});

describe("tiempo", () => {
  it("lee Open-Meteo y describe el código WMO", () => {
    const f = parseOpenMeteo(openMeteo("2026-11-02", { temp: 2, prob: 60, code: 61 }), "Turku");
    expect(f.daily[0]).toMatchObject({ date: "2026-11-02", max: 5, min: -1, description: "lluvia débil", sunrise: "2026-11-02T08:05" });
    expect(weatherAt(f, "2026-11-02T15:42")).toMatchObject({ time: "2026-11-02T15:00", temperature: 2 });
  });

  it("guarda la previsión en caché una hora", async () => {
    const env = testEnv();
    const { fn, calls } = fakeFetch([[/open-meteo/, () => json(openMeteo("2026-11-02", { temp: 2, prob: 10 }))]]);
    await getForecast(env.DB, S, fn);
    await getForecast(env.DB, S, fn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("timezone=Europe%2FHelsinki");
    expect(calls[0]!.url).toContain("latitude=60.4518");
  });
});

describe("bici", () => {
  const good = { time: "", temperature: 15, precipitationProbability: 5, precipitation: 0, windSpeed: 3, code: 1, description: "casi despejado" };
  const base = { fromMonth: 4, toMonth: 10, maxMinutes: 25, bikeMinutes: 15, weather: good };
  it("sí con buen tiempo, en temporada y trayecto corto", () => {
    expect(bikeVerdict({ ...base, month: 6 }).ok).toBe(true);
  });
  it("nunca en invierno", () => {
    expect(bikeVerdict({ ...base, month: 1 })).toEqual({ ok: false, reason: "En invierno, nada de bici." });
    expect(bikeVerdict({ ...base, month: 11 }).ok).toBe(false);
  });
  it("no con lluvia, frío, viento o trayecto largo", () => {
    expect(bikeVerdict({ ...base, month: 6, weather: { ...good, precipitationProbability: 40 } }).ok).toBe(false);
    expect(bikeVerdict({ ...base, month: 6, weather: { ...good, temperature: 3 } }).ok).toBe(false);
    expect(bikeVerdict({ ...base, month: 6, weather: { ...good, windSpeed: 11 } }).ok).toBe(false);
    expect(bikeVerdict({ ...base, month: 6, bikeMinutes: 40 }).ok).toBe(false);
  });
  it("temporada que cruza el año (p. ej. de octubre a marzo)", () => {
    expect(bikeVerdict({ ...base, fromMonth: 10, toMonth: 3, month: 1 }).ok).toBe(true);
    expect(bikeVerdict({ ...base, fromMonth: 10, toMonth: 3, month: 6 }).ok).toBe(false);
  });
});

describe("rutas", () => {
  it("la salida es el primer bus menos lo que se camina antes", () => {
    const r = parseTransitResponse(transitResponse("2026-11-02T13:12:00Z"), Date.parse(at("2026-11-02T15:35")))!;
    // Bus a las 15:12 (UTC+2), 5 min andando antes: salir 15:07.
    expect(new Date(r.leaveAt).toISOString()).toBe("2026-11-02T13:07:00.000Z");
    expect(r.minutes).toBe(25);
    expect(r.steps.map((s) => s.mode)).toEqual(["WALK", "TRANSIT", "WALK"]);
    expect(r.summary).toBe("5 min andando, bus 18 hacia Kauppatori desde Ylioppilaskylä, 5 min andando");
  });

  it("si todo es a pie, sale a la hora de llegada menos la duración", () => {
    const r = parseTransitResponse({ routes: [{ duration: "600s", legs: [{ steps: [{ travelMode: "WALK", staticDuration: "600s" }] }] }] }, 1_000_000_000)!;
    expect(r.leaveAt).toBe(1_000_000_000 - 600_000);
  });

  const work: CalendarEvent = { id: "w", title: "Trabajo", start: at("2026-11-02T15:45"), end: at("2026-11-02T22:00"), kind: "work_planned" };

  it("hora de salida con la Routes API, el margen de llegada y sin bici en noviembre", async () => {
    const env = testEnv();
    const { fn, calls } = fakeFetch([[/routes\.googleapis/, () => json(transitResponse("2026-11-02T13:12:00Z"))]]);
    const d = await planDeparture({ db: env.DB, event: work, settings: S, mapsKey: "k", fetchImpl: fn });
    expect(d).toMatchObject({ source: "routes_api", leaveAt: "2026-11-02T15:07", arriveBy: "2026-11-02T15:35", minutes: 25 });
    expect(d.bike).toEqual({ ok: false, reason: "En invierno, nada de bici." });
    const req = JSON.parse(calls[0]!.body!);
    expect(req).toMatchObject({ travelMode: "TRANSIT", origin: { address: "Casa 1, Turku" }, destination: { address: "Trabajo 2, Turku" } });
    expect(req.arrivalTime).toBe("2026-11-02T13:35:00.000Z");
    expect((calls[0]!.init!.headers as Record<string, string>)["X-Goog-FieldMask"]).toContain("transitDetails");
    // Segunda vez, de la caché.
    await planDeparture({ db: env.DB, event: work, settings: S, mapsKey: "k", fetchImpl: fn });
    expect(calls).toHaveLength(1);
  });

  it("propone la bici en temporada con buen tiempo", async () => {
    const env = testEnv();
    const summer: CalendarEvent = { ...work, start: at("2026-06-10T15:45"), end: at("2026-06-10T22:00") };
    const { fn } = fakeFetch([
      [/routes\.googleapis/, (c) => (JSON.parse(c.body!).travelMode === "BICYCLE" ? json({ routes: [{ duration: "960s" }] }) : json(transitResponse("2026-06-10T12:12:00Z")))],
      [/open-meteo/, () => json(openMeteo("2026-06-10", { temp: 18, prob: 5 }))],
    ]);
    const d = await planDeparture({ db: env.DB, event: summer, settings: S, mapsKey: "k", fetchImpl: fn });
    expect(d.bike).toEqual({ ok: true, reason: "Buen tiempo (18 °C) y son 16 min." });
  });

  it("sin clave o sin direcciones, estima con el trayecto por defecto", async () => {
    const env = testEnv();
    const d1 = await planDeparture({ db: env.DB, event: work, settings: S });
    expect(d1).toMatchObject({ source: "estimate", leaveAt: "2026-11-02T15:05" });
    const d2 = await planDeparture({ db: env.DB, event: work, settings: { ...S, homeAddress: "" }, mapsKey: "k" });
    expect(d2.note).toContain("direcciones");
  });

  it("si la Routes API falla, también estima y lo explica", async () => {
    const env = testEnv();
    const { fn } = fakeFetch([[/routes\.googleapis/, () => new Response("quota", { status: 429 })]]);
    const d = await planDeparture({ db: env.DB, event: work, settings: S, mapsKey: "k", fetchImpl: fn });
    expect(d.source).toBe("estimate");
    expect(d.note).toContain("429");
  });
});
