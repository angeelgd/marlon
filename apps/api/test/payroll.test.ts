import { DEFAULT_SETTINGS } from "@marlon/shared";
import { describe, expect, it } from "vitest";
import { expiringRuleSet, listRuleSets, logActualShift, monthPay, ruleSetFor, saveRuleSet } from "../src/money/payroll";
import { testEnv } from "./helpers";

async function plan(db: D1Database, rows: [string, string, string, number?][]) {
  for (const [date, s, e, next] of rows) {
    await db.prepare(`INSERT INTO planned_shifts (date, start_time, end_time, ends_next_day, hours) VALUES (?, ?, ?, ?, 0)`)
      .bind(date, s, e, next ?? 0)
      .run();
  }
}

describe("horas reales y sueldo del mes", () => {
  it("sin decir nada, lo real es lo planificado", async () => {
    const env = testEnv();
    await plan(env.DB, [
      ["2026-11-04", "15:45", "22:00"],
      ["2026-11-08", "12:45", "20:00"],
    ]);
    const m = await monthPay(env.DB, "2026-11", DEFAULT_SETTINGS);
    // 91,225 + 204,25 = 295,475 → 295,48 € (se redondea solo el total).
    expect(m.plannedCents).toBe(29548);
    expect(m.actualCents).toBe(29548);
    expect(m.differenceCents).toBe(0);
    expect(m.differingDays).toEqual([]);
    expect(m.days.every((d) => d.assumed)).toBe(true);
    expect(m.disclaimer).toContain("nómina");
  });

  it("'hoy salí a las 21:00' cambia solo lo real y se listan los días distintos", async () => {
    const env = testEnv();
    await plan(env.DB, [
      ["2026-11-04", "15:45", "22:00"],
      ["2026-11-05", "15:45", "22:00"],
      ["2026-11-06", "17:00", "23:30"],
    ]);
    const r = await logActualShift(env.DB, { date: "2026-11-04", end: "21:00" });
    expect(r).toMatchObject({ start: "15:45", end: "21:00", planned: "15:45-22:00" });
    await logActualShift(env.DB, { date: "2026-11-06", dayOff: true });
    // Turno extra no planificado.
    await logActualShift(env.DB, { date: "2026-11-07", start: "10:00", end: "14:00" });

    const m = await monthPay(env.DB, "2026-11", DEFAULT_SETTINGS);
    expect(m.differingDays.map((d) => [d.date, d.planned, d.actual])).toEqual([
      ["2026-11-04", "15:45-22:00", "15:45-21:00"],
      ["2026-11-06", "17:00-23:30", null],
      ["2026-11-07", null, "10:00-14:00"],
    ]);
    // Planificado: 91,225 + 91,225 + (1h × 13,70 + 5,5h × 15,10 = 96,75) = 279,20
    expect(m.plannedCents).toBe(27920);
    // Real: 76,125 + 91,225 + 0 + 4 × 13,70 = 222,15
    expect(m.actualCents).toBe(22215);
    expect(m.differenceCents).toBe(22215 - 27920);
    // Lo planificado sigue intacto.
    const p = await env.DB.prepare(`SELECT end_time FROM planned_shifts WHERE date = '2026-11-04'`).first<{ end_time: string }>();
    expect(p!.end_time).toBe("22:00");
  });

  it("sin turno planificado pide las dos horas", async () => {
    const env = testEnv();
    await expect(logActualShift(env.DB, { date: "2026-11-10", end: "21:00" })).rejects.toThrow("hora de entrada");
  });

  it("marca vísperas por confirmar y no calcula lo que cruza a domingo sin regla", async () => {
    const env = testEnv();
    await plan(env.DB, [
      ["2026-12-24", "15:45", "22:00"],
      ["2026-12-19", "18:00", "01:30", 1], // sábado → domingo
    ]);
    const m = await monthPay(env.DB, "2026-12", DEFAULT_SETTINGS);
    expect(m.toConfirm.map((t) => t.date)).toContain("2026-12-24");
    expect(m.unresolved).toEqual([{ date: "2026-12-19", calendarDayEuros: 138.81, shiftStartEuros: 114.705 }]);
    // El total solo incluye lo calculable (la víspera en modo probable).
    expect(m.actualCents).toBe(13684);

    const min = await monthPay(env.DB, "2026-12", { ...DEFAULT_SETTINGS, payEveMode: "minimum", payMidnightRule: "calendar_day" });
    expect(min.unresolved).toEqual([]);
    expect(min.actualCents).toBe(Math.floor((9402.5 + 13881) + 0.5));
  });
});

describe("tablas de sueldo con vigencia", () => {
  it("elige la tabla por fecha y avisa un mes antes de que caduque sin sustituta", async () => {
    const env = testEnv();
    const sets = await listRuleSets(env.DB);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.validTo).toBe("2027-06-30");
    expect(expiringRuleSet(sets, "2027-05-30")).toBeNull();
    expect(expiringRuleSet(sets, "2027-05-31")?.id).toBe("rules_2027");

    await saveRuleSet(env.DB, { validFrom: "2027-07-01", validTo: null, rules: { ...sets[0]!.rules, baseCents: 1410 }, note: "Subida" });
    const after = await listRuleSets(env.DB);
    expect(expiringRuleSet(after, "2027-06-10")).toBeNull();
    expect(ruleSetFor(after, "2027-06-30")!.rules.baseCents).toBe(1370);
    expect(ruleSetFor(after, "2027-07-01")!.rules.baseCents).toBe(1410);
  });

  it("valida la tabla", async () => {
    const env = testEnv();
    const sets = await listRuleSets(env.DB);
    await expect(
      saveRuleSet(env.DB, { validFrom: "2027-07-01", validTo: "2027-01-01", rules: sets[0]!.rules, note: null }),
    ).rejects.toThrow("anterior");
  });
});
