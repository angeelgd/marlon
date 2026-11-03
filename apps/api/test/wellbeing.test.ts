import { sessionPosition } from "@marlon/shared";
import { describe, expect, it } from "vitest";
import { localToUtcIso, toLocalIso } from "../src/lib/time";
import { MEDITATIONS, pickMeditation, STRETCH_ROUTINES } from "../src/wellbeing/guided";
import {
  activeSession,
  cancelSession,
  intervalPhases,
  pauseSession,
  phaseNotifications,
  resumeSession,
  startSession,
  totalSeconds,
  validatePhases,
} from "../src/wellbeing/sessions";
import { breakFor, planStudy } from "../src/wellbeing/study";
import { testEnv, TZ } from "./helpers";

const at = (s: string) => Date.parse(localToUtcIso(s, TZ));

describe("intervalos", () => {
  it("'30 de estudio, 5 de descanso, 4 veces': sin descanso al final", () => {
    const p = intervalPhases({ workSeconds: 1800, restSeconds: 300, rounds: 4, workLabel: "Estudio" });
    expect(p.map((x) => [x.kind, x.seconds])).toEqual([
      ["work", 1800], ["rest", 300], ["work", 1800], ["rest", 300], ["work", 1800], ["rest", 300], ["work", 1800],
    ]);
    expect(p[0]!.label).toBe("Estudio 1/4");
    expect(totalSeconds(p)).toBe(4 * 1800 + 3 * 300);
  });

  it("'40 s de ejercicio, 20 de descanso, 8 rondas'", () => {
    const p = intervalPhases({ workSeconds: 40, restSeconds: 20, rounds: 8 });
    expect(p).toHaveLength(15);
    expect(totalSeconds(p)).toBe(8 * 40 + 7 * 20);
  });

  it("límites", () => {
    expect(() => intervalPhases({ workSeconds: 0, restSeconds: 0, rounds: 1 })).toThrow();
    expect(() => validatePhases([{ label: "x", seconds: 5 * 3600, kind: "work" }])).toThrow("4 horas");
    expect(() => validatePhases([{ label: "x", seconds: 2, kind: "work" }])).toThrow("5 segundos");
  });

  it("posición actual en la sesión", () => {
    const p = intervalPhases({ workSeconds: 40, restSeconds: 20, rounds: 2 });
    expect(sessionPosition(p, 0)).toEqual({ index: 0, remaining: 40, phaseElapsed: 0 });
    expect(sessionPosition(p, 45)).toEqual({ index: 1, remaining: 15, phaseElapsed: 5 });
    expect(sessionPosition(p, 100)).toBeNull();
  });
});

describe("avisos por fase", () => {
  it("un aviso en cada cambio de fase y otro al final, a su hora exacta", () => {
    const phases = intervalPhases({ workSeconds: 40, restSeconds: 20, rounds: 2 });
    const start = Date.parse("2026-11-03T10:00:00Z");
    const n = phaseNotifications({ id: "s1", kind: "timer", title: "HIIT", phases }, start);
    expect(n.map((x) => [new Date(x.at).toISOString().slice(11, 19), x.title])).toEqual([
      ["10:00:40", "Descanso · 20 s"],
      ["10:01:00", "¡Vamos! · 40 s"],
      ["10:01:40", "Sesión completada"],
    ]);
    expect(new Set(n.map((x) => x.key)).size).toBe(3);
  });

  it("la meditación solo avisa al final (para no interrumpir)", () => {
    const n = phaseNotifications({ id: "m", kind: "meditation", title: "Med", phases: MEDITATIONS[5].phases }, 0);
    expect(n).toHaveLength(1);
    expect(n[0]!.at).toBe(5 * 60 * 1000);
  });
});

describe("sesiones guardadas", () => {
  it("arrancar, pausar, reanudar y cancelar reprograman los avisos", async () => {
    const env = testEnv();
    const t0 = Date.parse("2026-11-03T10:00:00Z");
    const s = await startSession(env, { kind: "timer", title: "HIIT", phases: intervalPhases({ workSeconds: 40, restSeconds: 20, rounds: 2 }) }, t0);
    const pending = async () =>
      (await env.DB.prepare(`SELECT send_at FROM notifications WHERE status = 'pending' ORDER BY send_at`).all<{ send_at: string }>()).results.map((r) =>
        r.send_at.slice(11, 19),
      );
    expect(await pending()).toEqual(["10:00:40", "10:01:00", "10:01:40"]);

    // Pausa a los 50 s (en el descanso) durante 2 minutos.
    await pauseSession(env, s.id, t0 + 50_000);
    expect(await pending()).toEqual([]);
    expect((await activeSession(env.DB, t0 + 60_000))!.status).toBe("paused");
    const r = await resumeSession(env, s.id, t0 + 170_000);
    expect(r.startedAt).toBe(new Date(t0 + 120_000).toISOString());
    // Quedan: vuelta al trabajo a los 60 s de sesión (10:03:00) y fin (10:03:40).
    expect(await pending()).toEqual(["10:03:00", "10:03:40"]);

    await cancelSession(env, s.id);
    expect(await pending()).toEqual([]);
    expect(await activeSession(env.DB, t0 + 180_000)).toBeNull();
  });

  it("solo una sesión activa, y la terminada se marca sola", async () => {
    const env = testEnv();
    const t0 = Date.parse("2026-11-03T10:00:00Z");
    const a = await startSession(env, { kind: "meditation", title: "A", phases: MEDITATIONS[3].phases }, t0);
    const b = await startSession(env, { kind: "stretch", title: "B", phases: [...STRETCH_ROUTINES.desk.phases] }, t0 + 1000);
    expect((await activeSession(env.DB, t0 + 2000))!.id).toBe(b.id);
    const st = await env.DB.prepare(`SELECT status FROM sessions_wellbeing WHERE id = ?`).bind(a.id).first<{ status: string }>();
    expect(st!.status).toBe("cancelled");
    expect(await activeSession(env.DB, t0 + 3600_000)).toBeNull();
  });
});

describe("meditaciones y estiramientos", () => {
  it("las meditaciones duran lo que dicen", () => {
    for (const m of [3, 5, 10] as const) expect(totalSeconds(MEDITATIONS[m].phases)).toBe(m * 60);
  });

  it("elige la duración según el tiempo libre", () => {
    expect(pickMeditation(6)).toBe(3);
    expect(pickMeditation(12)).toBe(5);
    expect(pickMeditation(45)).toBe(10);
    expect(pickMeditation(null)).toBe(5);
    expect(pickMeditation(2, 10)).toBe(10);
  });

  it("textos sin guiones como puntuación", () => {
    const all = [...Object.values(MEDITATIONS).flatMap((m) => m.phases), ...Object.values(STRETCH_ROUTINES).flatMap((r) => r.phases)];
    for (const p of all) expect(p.text ?? "").not.toMatch(/[—–]| - /);
  });
});

describe("bloques de estudio", () => {
  const base = {
    blockMinutes: 50,
    breakRatio: 0.2,
    maxBlocksPerDay: 4,
    dayStart: "08:00",
    dayEnd: "20:00",
    tz: TZ,
    bufferMin: 30,
    notBefore: at("2026-11-02T00:00"),
  };

  it("descanso proporcional", () => {
    expect(breakFor(50, 0.2)).toBe(10);
    expect(breakFor(25, 0.2)).toBe(5);
    expect(breakFor(90, 0.2)).toBe(20);
  });

  it("reparte entre días y respeta los compromisos", () => {
    const busy = [
      { start: at("2026-11-02T15:45"), end: at("2026-11-02T22:00") },
      { start: at("2026-11-03T08:15"), end: at("2026-11-03T12:00") },
    ];
    const r = planStudy({ ...base, fromDate: "2026-11-02", toDate: "2026-11-04", totalMinutes: 300, busy });
    expect(r.missingBlocks).toBe(0);
    expect(r.breakMinutes).toBe(10);
    expect(r.sessions.reduce((a, s) => a + s.blocks, 0)).toBe(6);
    expect(new Set(r.sessions.map((s) => s.date)).size).toBe(3);
    for (const s of r.sessions) {
      for (const b of busy) expect(s.end <= b.start - 30 * 60_000 || s.start >= b.end + 30 * 60_000).toBe(true);
      expect(s.end - s.start).toBe((s.blocks * 50 + (s.blocks - 1) * 10) * 60_000);
    }
    expect(toLocalIso(r.sessions[0]!.start, TZ)).toBe("2026-11-02T08:00");
  });

  it("si no cabe todo, dice cuántos bloques faltan", () => {
    const r = planStudy({ ...base, fromDate: "2026-11-02", toDate: "2026-11-02", totalMinutes: 1000, busy: [] });
    expect(r.sessions.reduce((a, s) => a + s.blocks, 0)).toBe(4);
    expect(r.missingBlocks).toBe(16);
  });
});
