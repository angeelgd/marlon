import { describe, expect, it } from "vitest";
import { findFreeSlots, mergeIntervals } from "../src/schedule/slots";
import { localToMs, toLocalIso } from "../src/lib/time";

const TZ = "Europe/Helsinki";
const at = (s: string) => localToMs(s, TZ);
const fmt = (ms: number) => toLocalIso(ms, TZ);

describe("mergeIntervals", () => {
  it("une solapes y contiguos", () => {
    expect(
      mergeIntervals([
        { start: 5, end: 10 },
        { start: 0, end: 5 },
        { start: 20, end: 30 },
        { start: 25, end: 26 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
  });
});

describe("findFreeSlots", () => {
  const base = { tz: TZ, dayStart: "07:00", dayEnd: "22:00" };

  it("día vacío devuelve la ventana completa", () => {
    const slots = findFreeSlots({ ...base, fromDate: "2026-11-02", toDate: "2026-11-02", durationMin: 60, busy: [] });
    expect(slots.map((s) => [fmt(s.start), fmt(s.end)])).toEqual([["2026-11-02T07:00", "2026-11-02T22:00"]]);
  });

  it("parte los huecos alrededor de los compromisos", () => {
    const slots = findFreeSlots({
      ...base,
      fromDate: "2026-11-02",
      toDate: "2026-11-02",
      durationMin: 60,
      busy: [
        { start: at("2026-11-02T09:00"), end: at("2026-11-02T12:00") },
        { start: at("2026-11-02T15:45"), end: at("2026-11-02T22:00") },
      ],
    });
    expect(slots.map((s) => [fmt(s.start), fmt(s.end), s.minutes])).toEqual([
      ["2026-11-02T07:00", "2026-11-02T09:00", 120],
      ["2026-11-02T12:00", "2026-11-02T15:45", 225],
    ]);
  });

  it("descarta huecos más cortos que la duración y aplica margen", () => {
    const slots = findFreeSlots({
      ...base,
      fromDate: "2026-11-02",
      toDate: "2026-11-02",
      durationMin: 80,
      bufferMin: 10,
      busy: [
        { start: at("2026-11-02T08:00"), end: at("2026-11-02T09:00") },
        { start: at("2026-11-02T10:30"), end: at("2026-11-02T21:00") },
      ],
    });
    // 07:00 a 07:50 (50 min) y 09:10 a 10:20 (70 min) no llegan a 80 min.
    expect(slots).toEqual([]);
  });

  it("trabaja con varios días y eventos que cruzan la medianoche", () => {
    const slots = findFreeSlots({
      ...base,
      fromDate: "2026-11-06",
      toDate: "2026-11-07",
      durationMin: 60,
      busy: [{ start: at("2026-11-06T18:00"), end: at("2026-11-07T08:30") }],
    });
    expect(slots.map((s) => [s.date, fmt(s.start), fmt(s.end)])).toEqual([
      ["2026-11-06", "2026-11-06T07:00", "2026-11-06T18:00"],
      ["2026-11-07", "2026-11-07T08:30", "2026-11-07T22:00"],
    ]);
  });

  it("respeta notBefore", () => {
    const slots = findFreeSlots({
      ...base,
      fromDate: "2026-11-02",
      toDate: "2026-11-02",
      durationMin: 30,
      busy: [],
      notBefore: at("2026-11-02T20:00"),
    });
    expect(slots.map((s) => fmt(s.start))).toEqual(["2026-11-02T20:00"]);
  });
});

describe("zona horaria", () => {
  it("convierte hora local de Helsinki a UTC con y sin horario de verano", () => {
    expect(new Date(at("2026-07-01T12:00")).toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(new Date(at("2026-12-01T12:00")).toISOString()).toBe("2026-12-01T10:00:00.000Z");
  });

  it("el cambio de hora no rompe los huecos del día", () => {
    // 25 de octubre de 2026: Helsinki pasa de UTC+3 a UTC+2.
    const slots = findFreeSlots({ tz: TZ, dayStart: "07:00", dayEnd: "22:00", fromDate: "2026-10-25", toDate: "2026-10-25", durationMin: 60, busy: [] });
    expect(slots[0]!.minutes).toBe(15 * 60);
  });
});
