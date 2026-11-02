import { DEFAULT_SETTINGS, SettingsSchema, type CalendarEvent } from "@marlon/shared";
import { describe, expect, it } from "vitest";
import { bestGymSlot, planGymWeek } from "../src/planning/gym";
import { planSleep, toCommitments } from "../src/planning/sleep";
import { localToUtcIso, toLocalIso } from "../src/lib/time";

const TZ = "Europe/Helsinki";
const S = { ...DEFAULT_SETTINGS };
const at = (s: string) => localToUtcIso(s, TZ);
const t = (ms: number) => toLocalIso(ms, TZ);
let n = 0;
const ev = (title: string, start: string, end: string, kind: CalendarEvent["kind"] = "work_planned"): CalendarEvent => ({
  id: `e${++n}`,
  title,
  start: at(start),
  end: at(end),
  kind,
});

const WEEK = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
const SUNDAY_BEFORE = Date.parse(at("2026-11-01T20:00"));

const typicalWeek = () =>
  toCommitments([
    ev("Trabajo", "2026-11-02T15:45", "2026-11-02T22:00"),
    ev("Clase", "2026-11-03T08:15", "2026-11-03T10:00", "university"),
    ev("Trabajo", "2026-11-04T16:00", "2026-11-04T22:00"),
    ev("Clase", "2026-11-05T09:00", "2026-11-05T11:00", "university"),
    ev("Trabajo", "2026-11-05T15:45", "2026-11-05T22:00"),
    ev("Trabajo", "2026-11-06T17:00", "2026-11-06T23:30"),
    ev("Trabajo", "2026-11-08T12:45", "2026-11-08T20:00"),
  ]);

describe("sueño", () => {
  it("la hora de levantarse sale hacia atrás desde el primer compromiso", () => {
    const sleep = planSleep(WEEK, typicalWeek(), S);
    const tue = sleep.find((d) => d.date === "2026-11-03")!;
    // Clase 08:15, menos 30 de trayecto y 45 de rutina = 07:00; acostarse el lunes a las 23:00.
    expect(t(tue.wake)).toBe("2026-11-03T07:00");
    expect(t(tue.bedBefore)).toBe("2026-11-02T23:00");
    // El lunes sale a las 22:00: 30 de vuelta y 30 para relajarse, justo las 23:00.
    expect(tue.ok).toBe(true);
    expect(tue.anchor?.title).toBe("Clase");
  });

  it("en días libres usa la hora de levantarse de los ajustes", () => {
    const sat = planSleep(WEEK, typicalWeek(), S).find((d) => d.date === "2026-11-07")!;
    expect(t(sat.wake)).toBe("2026-11-07T08:30");
    expect(sat.anchor).toBeNull();
    // El viernes sale a las 23:30: puede acostarse a las 00:30, justo 8 h antes de las 08:30.
    expect(sat.ok).toBe(true);
  });

  it("avisa cuando los compromisos no dejan dormir 8 horas, sin recortar nada", () => {
    const c = toCommitments([
      ev("Trabajo", "2026-11-06T17:00", "2026-11-06T23:30"),
      ev("Clase", "2026-11-07T07:30", "2026-11-07T09:00", "university"),
    ]);
    const sat = planSleep(["2026-11-07"], c, S)[0]!;
    expect(sat.ok).toBe(false);
    // Levantarse 06:15, acostarse 22:15, pero no se puede antes de las 00:30: faltan 135 min.
    expect(sat.shortByMin).toBe(135);
  });

  it("8 horas es el mínimo: los ajustes no aceptan menos", () => {
    expect(SettingsSchema.safeParse({ sleepHours: 7 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ sleepHours: 8.5 }).success).toBe(true);
  });
});

describe("gimnasio", () => {
  it("coloca 3 o 4 sesiones, de mañana cuando se puede, sin días seguidos", () => {
    const plan = planGymWeek(WEEK, typicalWeek(), S, SUNDAY_BEFORE);
    expect(plan.sessions.length).toBeGreaterThanOrEqual(3);
    expect(plan.sessions.length).toBeLessThanOrEqual(4);
    expect(plan.belowTarget).toBe(false);
    const dates = plan.sessions.map((s) => s.date);
    for (let i = 1; i < dates.length; i++) {
      expect(Date.parse(dates[i]!) - Date.parse(dates[i - 1]!)).toBeGreaterThan(86_400_000);
    }
    expect(plan.sessions.every((s) => s.morning)).toBe(true);
    for (const s of plan.sessions) {
      const minutes = (s.end - s.start) / 60_000;
      expect(minutes).toBeGreaterThanOrEqual(80);
      expect(minutes).toBeLessThanOrEqual(140);
    }
  });

  it("el lunes (trabajo a las 15:45) va por la mañana tras levantarse a su hora", () => {
    const c = bestGymSlot("2026-11-02", typicalWeek(), S, SUNDAY_BEFORE)!;
    expect(t(c.start)).toBe("2026-11-02T08:45");
    expect(t(c.end)).toBe("2026-11-02T11:05");
    expect(c.tight).toBe(false);
  });

  it("nunca recorta el sueño: tras salir tarde, no hay gimnasio a primera hora", () => {
    // Martes: clase 08:15. Antes no cabe (levantarse a las 07:00 como pronto).
    const c = bestGymSlot("2026-11-03", typicalWeek(), S, SUNDAY_BEFORE)!;
    expect(Date.parse(at("2026-11-03T10:00"))).toBeLessThan(c.start);
    for (const s of planGymWeek(WEEK, typicalWeek(), S, SUNDAY_BEFORE).sleep) {
      if (s.date !== "2026-11-07") expect(s.ok, s.date).toBe(true);
    }
  });

  it("si el hueco es justo, lo marca para preguntar", () => {
    // Clase de 09:00 a 10:00 y trabajo desde las 13:20: antes de clase no cabe y por la tarde tampoco.
    const c = toCommitments([
      ev("Clase", "2026-11-10T09:00", "2026-11-10T10:00", "university"),
      ev("Trabajo", "2026-11-10T13:20", "2026-11-10T22:00"),
    ]);
    const slot = bestGymSlot("2026-11-10", c, S, SUNDAY_BEFORE)!;
    // Entre 10:30 (clase + trayecto) y 12:20 (trabajo menos trayecto y ducha) hay 110 min.
    expect(t(slot.start)).toBe("2026-11-10T10:30");
    expect(slot.tight).toBe(true);
    expect(slot.available).toBe(110);
  });

  it("si no cabe nada, lo dice y no llega al objetivo", () => {
    const busy = WEEK.map((d) => ev("Trabajo", `${d}T07:30`, `${d}T21:30`));
    const plan = planGymWeek(WEEK, toCommitments(busy), S, SUNDAY_BEFORE);
    expect(plan.sessions).toEqual([]);
    expect(plan.noRoom).toEqual(WEEK);
    expect(plan.belowTarget).toBe(true);
  });

  it("usa la tarde si la mañana está ocupada", () => {
    const c = toCommitments([ev("Clase", "2026-11-11T08:00", "2026-11-11T15:00", "university")]);
    const slot = bestGymSlot("2026-11-11", c, { ...S }, SUNDAY_BEFORE)!;
    expect(slot.morning).toBe(false);
    expect(t(slot.start)).toBe("2026-11-11T15:30");
  });

  it("no planifica días pasados", () => {
    const plan = planGymWeek(WEEK, typicalWeek(), S, Date.parse(at("2026-11-06T12:00")));
    expect(plan.sessions.every((s) => s.date >= "2026-11-06")).toBe(true);
  });
});
