import { describe, expect, it } from "vitest";
import {
  inferDate,
  parseHours,
  parseMonthDay,
  parseSchedule,
  parseTime,
  parseWeekday,
  type RawRow,
} from "../src/schedule/parse";

const row = (date: string | null, weekday: string | null, start: string | null, end: string | null, hours: string | null): RawRow => ({
  date,
  weekday,
  start,
  end,
  hours,
});

describe("piezas sueltas", () => {
  it("lee fechas en varios formatos", () => {
    expect(parseMonthDay("Oct-19")).toEqual([10, 19]);
    expect(parseMonthDay("19-Oct")).toEqual([10, 19]);
    expect(parseMonthDay("Oct 19")).toEqual([10, 19]);
    expect(parseMonthDay("19.10")).toEqual([10, 19]);
    expect(parseMonthDay("Dic-24")).toEqual([12, 24]);
    expect(parseMonthDay("Foo-19")).toBeNull();
    expect(parseMonthDay("Oct-45")).toBeNull();
  });

  it("lee días de la semana en inglés, español y finés", () => {
    expect(parseWeekday("Sun")).toBe(0);
    expect(parseWeekday("Monday")).toBe(1);
    expect(parseWeekday("mié")).toBe(3);
    expect(parseWeekday("Sáb")).toBe(6);
    expect(parseWeekday("ke")).toBe(3);
    expect(parseWeekday("")).toBeNull();
  });

  it("lee horas y totales", () => {
    expect(parseTime("15.45")).toBe("15:45");
    expect(parseTime("9.00")).toBe("09:00");
    expect(parseTime("22")).toBe("22:00");
    expect(parseTime("24.00")).toBe("24:00");
    expect(parseTime("25.00")).toBeNull();
    expect(parseHours("6,25")).toBe(6.25);
    expect(parseHours("0,00")).toBe(0);
    expect(parseHours("")).toBeNull();
    expect(parseHours("abc")).toBe("invalid");
  });
});

describe("inferencia del año", () => {
  it("elige el año más cercano", () => {
    expect(inferDate(10, 19, null, "2026-10-01").date).toBe("2026-10-19");
  });

  it("en diciembre, enero es del año siguiente", () => {
    expect(inferDate(1, 5, null, "2026-12-20").date).toBe("2027-01-05");
  });

  it("en enero, diciembre es del año anterior", () => {
    expect(inferDate(12, 28, null, "2027-01-03").date).toBe("2026-12-28");
  });

  it("usa el día de la semana para confirmar", () => {
    // 19 de octubre de 2026 es lunes.
    const r = inferDate(10, 19, 1, "2026-10-01");
    expect(r).toEqual({ date: "2026-10-19", weekdayMatches: true });
  });

  it("marca el día de la semana que no cuadra", () => {
    const r = inferDate(10, 19, 3, "2026-10-01");
    expect(r.weekdayMatches).toBe(false);
  });
});

describe("parseSchedule", () => {
  const today = "2026-10-15";

  it("convierte un horario típico", () => {
    const res = parseSchedule(
      [
        row("Oct-19", "Mon", "15.45", "22.00", "6,25"),
        row("Oct-20", "Tue", "", "", "0,00"),
        row("Oct-21", "Wed", "16.00", "23.30", "7,50"),
      ],
      today,
    );
    expect(res.issues).toEqual([]);
    expect(res.daysOff).toEqual(["2026-10-20"]);
    expect(res.shifts).toEqual([
      { date: "2026-10-19", start: "15:45", end: "22:00", endsNextDay: false, hours: 6.25, flagged: false },
      { date: "2026-10-21", start: "16:00", end: "23:30", endsNextDay: false, hours: 7.5, flagged: false },
    ]);
  });

  it("detecta turnos que cruzan la medianoche", () => {
    const res = parseSchedule([row("Oct-24", "Sat", "18.00", "01.30", "7,50")], today);
    expect(res.issues).toEqual([]);
    expect(res.shifts[0]).toMatchObject({ start: "18:00", end: "01:30", endsNextDay: true, hours: 7.5 });
  });

  it("acepta 24.00 como fin de turno", () => {
    const res = parseSchedule([row("Oct-24", "Sat", "18.00", "24.00", "6,00")], today);
    expect(res.issues).toEqual([]);
    expect(res.shifts[0]).toMatchObject({ end: "00:00", endsNextDay: true });
  });

  it("señala cuando salida menos entrada no coincide con las horas", () => {
    const res = parseSchedule([row("Oct-19", "Mon", "15.45", "22.00", "6,50")], today);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]!.kind).toBe("hours_mismatch");
    expect(res.shifts[0]!.flagged).toBe(true);
  });

  it("señala filas incompletas", () => {
    const res = parseSchedule(
      [row("Oct-19", "Mon", "15.45", "", "6,25"), row("Oct-20", "Tue", "", "", "5,00")],
      today,
    );
    expect(res.issues.map((i) => i.kind)).toEqual(["incomplete", "incomplete"]);
    expect(res.shifts).toEqual([]);
  });

  it("señala fechas ilegibles y duplicadas, e ignora separadores vacíos", () => {
    const res = parseSchedule(
      [
        row("Oct-19", "Mon", "15.45", "22.00", "6,25"),
        row(null, null, null, null, null),
        row("??", "Tue", "15.45", "22.00", "6,25"),
        row("Oct-19", "Mon", "15.45", "22.00", "6,25"),
      ],
      today,
    );
    expect(res.issues.map((i) => i.kind)).toEqual(["unreadable_date", "duplicate_date"]);
    expect(res.shifts).toHaveLength(1);
  });

  it("calcula las horas si la columna viene vacía", () => {
    const res = parseSchedule([row("Oct-19", "Mon", "15.45", "22.00", null)], today);
    expect(res.shifts[0]!.hours).toBe(6.25);
  });

  it("horario que salta de diciembre a enero", () => {
    const res = parseSchedule(
      [row("Dec-31", "Thu", "15.00", "22.00", "7,00"), row("Jan-02", "Sat", "15.00", "22.00", "7,00")],
      "2026-12-20",
    );
    expect(res.issues).toEqual([]);
    expect(res.shifts.map((s) => s.date)).toEqual(["2026-12-31", "2027-01-02"]);
  });
});
