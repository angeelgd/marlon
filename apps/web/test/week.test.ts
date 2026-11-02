import { localToUtcIso } from "@marlon/shared";
import { describe, expect, it } from "vitest";
import { mondayOf, segmentsOf, weekDays } from "../src/lib/week";

const TZ = "Europe/Helsinki";

describe("semana", () => {
  it("el lunes de la semana", () => {
    expect(mondayOf(Date.parse("2026-11-08T12:00:00Z"), TZ)).toBe("2026-11-02"); // domingo
    expect(mondayOf(Date.parse("2026-11-02T00:30:00Z"), TZ)).toBe("2026-11-02"); // lunes 02:30 en Helsinki
    expect(weekDays("2026-11-02")).toHaveLength(7);
  });

  it("parte en dos un turno que cruza la medianoche", () => {
    const days = weekDays("2026-11-02");
    const segs = segmentsOf(localToUtcIso("2026-11-06T18:00", TZ), localToUtcIso("2026-11-07T01:30", TZ), TZ, days);
    expect(segs).toEqual([
      { key: "2026-11-06", date: "2026-11-06", startMin: 18 * 60, endMin: 24 * 60, first: true },
      { key: "2026-11-07", date: "2026-11-07", startMin: 0, endMin: 90, first: false },
    ]);
  });

  it("ignora eventos fuera de la semana", () => {
    const days = weekDays("2026-11-02");
    expect(segmentsOf(localToUtcIso("2026-11-10T10:00", TZ), localToUtcIso("2026-11-10T11:00", TZ), TZ, days)).toEqual([]);
  });
});
