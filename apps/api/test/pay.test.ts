import type { PayRules } from "@marlon/shared";
import { describe, expect, it } from "vitest";
import { dayInfo, easterSunday, finnishCalendar } from "../src/money/holidays";
import { calcShift, centMinutesToEuros, roundCents, type ShiftTimes } from "../src/money/pay";

/** La tabla de la migración 0004 (importes brutos en céntimos). */
const RULES: PayRules = {
  baseCents: 1370,
  eveningSupplementCents: 140,
  eveningFrom: "18:00",
  nightSupplementCents: 237,
  nightTo: "06:00",
  sundayHolidayMultiplier: 2,
  sundayNightConfirmed: false,
  eveFrom: "15:00",
  eveMultiplier: 1.5,
};
const OPTS = { eveMode: "probable" as const, midnightRule: "ask" as const };
const shift = (date: string, start: string, end: string, endsNextDay = false): ShiftTimes => ({ date, start, end, endsNextDay });
const euros = (s: ReturnType<typeof calcShift>) => centMinutesToEuros(s.centMinutes!);

describe("tests obligatorios del calculador", () => {
  it("domingo de 12:45 a 20:00 = 204,25 €", () => {
    const r = calcShift(shift("2026-11-08", "12:45", "20:00"), RULES, OPTS);
    expect(r.dayType).toBe("sunday");
    expect(euros(r)).toBe(204.25);
    expect(r.segments.map((s) => [s.from, s.to, s.rateCents])).toEqual([
      ["12:45", "18:00", 2740],
      ["18:00", "20:00", 3020],
    ]);
  });

  it("domingo de 13:00 a 21:00 = 227,60 €", () => {
    expect(euros(calcShift(shift("2026-11-08", "13:00", "21:00"), RULES, OPTS))).toBe(227.6);
  });

  it("día normal de 15:45 a 22:00 = 91,225 € (y 91,23 € al redondear el total)", () => {
    const r = calcShift(shift("2026-11-04", "15:45", "22:00"), RULES, OPTS);
    expect(euros(r)).toBe(91.225);
    expect(roundCents(r.centMinutes!)).toBe(9123);
    expect(r.flags).toEqual([]);
  });
});

describe("tramos y suplementos", () => {
  it("suplemento de noche de 00:00 a 06:00 en día normal", () => {
    // Jueves 22:00 a viernes 02:00: 2 h de tarde (15,10) y 2 h de noche (13,70 + 2,37).
    const r = calcShift(shift("2026-11-05", "22:00", "02:00", true), RULES, OPTS);
    expect(euros(r)).toBeCloseTo(2 * 15.1 + 2 * 16.07, 6);
  });

  it("el suplemento de noche en domingo se dobla pero queda por confirmar", () => {
    const r = calcShift(shift("2026-11-08", "20:00", "23:59"), RULES, OPTS);
    expect(r.flags).not.toContain("sunday_night_unconfirmed");
    // Domingo 23:00 → lunes 01:00: la parte del lunes es normal + noche.
    const r2 = calcShift(shift("2026-11-08", "23:00", "01:00", true), RULES, OPTS);
    expect(euros(r2)).toBeCloseTo(30.2 + 16.07, 6);
    // Festivo de madrugada (Navidad 00:00 a 02:00, entrando el 25).
    const r3 = calcShift(shift("2026-12-25", "00:00", "02:00"), RULES, OPTS);
    expect(r3.flags).toContain("sunday_night_unconfirmed");
    expect(euros(r3)).toBeCloseTo(2 * (13.7 + 2.37) * 2, 6);
  });
});

describe("víspera de festivo", () => {
  it("modo probable: 20,55 €/h desde las 15:00 y 22,65 €/h desde las 18:00", () => {
    const r = calcShift(shift("2026-12-24", "15:45", "22:00"), RULES, OPTS);
    expect(r.dayType).toBe("eve");
    expect(r.dayName).toBe("Nochebuena");
    expect(r.segments.map((s) => s.rateCents)).toEqual([2055, 2265]);
    expect(euros(r)).toBe(136.838);
    expect(r.flags).toContain("eve_unconfirmed");
  });

  it("modo mínimo: 13,70 €/h hasta las 18:00 y 15,80 €/h después", () => {
    const r = calcShift(shift("2026-12-24", "15:45", "22:00"), RULES, { ...OPTS, eveMode: "minimum" });
    expect(r.segments.map((s) => s.rateCents)).toEqual([1370, 1580]);
    expect(euros(r)).toBe(94.025);
  });

  it("antes de las 15:00 la víspera es un día normal", () => {
    const r = calcShift(shift("2026-12-24", "12:00", "16:00"), RULES, OPTS);
    expect(euros(r)).toBeCloseTo(3 * 13.7 + 20.55, 6);
  });

  it("no se aplica si la víspera cae en domingo", () => {
    expect(dayInfo("2028-12-31").type).toBe("sunday");
    const r = calcShift(shift("2028-12-31", "15:00", "16:00"), RULES, OPTS);
    expect(r.flags).not.toContain("eve_unconfirmed");
    expect(euros(r)).toBe(27.4);
  });
});

describe("turnos que cruzan la medianoche hacia domingo o festivo", () => {
  const sat = shift("2026-11-07", "18:00", "01:30", true);

  it("con la regla 'preguntar' no supone nada y da las dos opciones", () => {
    const r = calcShift(sat, RULES, OPTS);
    expect(r.centMinutes).toBeNull();
    expect(r.flags).toContain("midnight_rule_needed");
    expect(centMinutesToEuros(r.options!.calendar_day)).toBe(138.81);
    expect(centMinutesToEuros(r.options!.shift_start)).toBe(114.705);
  });

  it("con una regla elegida, calcula", () => {
    expect(euros(calcShift(sat, RULES, { ...OPTS, midnightRule: "calendar_day" }))).toBe(138.81);
    expect(euros(calcShift(sat, RULES, { ...OPTS, midnightRule: "shift_start" }))).toBe(114.705);
  });

  it("un turno que acaba justo a las 00:00 no cruza", () => {
    const r = calcShift(shift("2026-11-07", "18:00", "00:00", true), RULES, OPTS);
    expect(r.centMinutes).not.toBeNull();
    expect(euros(r)).toBeCloseTo(6 * 15.1, 6);
  });
});

describe("festivos de Finlandia", () => {
  it("Pascua", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
  });

  it("festivos y vísperas de 2026", () => {
    const { holidays, eves } = finnishCalendar(2026);
    expect([...holidays.keys()].sort()).toEqual([
      "2026-01-01",
      "2026-01-06",
      "2026-04-03",
      "2026-04-05",
      "2026-04-06",
      "2026-05-01",
      "2026-05-14",
      "2026-05-24",
      "2026-06-20",
      "2026-10-31",
      "2026-12-06",
      "2026-12-25",
      "2026-12-26",
    ]);
    expect([...eves.keys()].sort()).toEqual(["2026-04-04", "2026-04-30", "2026-06-19", "2026-12-24", "2026-12-31"]);
    expect(dayInfo("2026-12-06").type).toBe("holiday");
    expect(dayInfo("2026-11-04").type).toBe("normal");
  });
});
