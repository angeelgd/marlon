import type { SessionPhase, WellbeingSession } from "@marlon/shared";
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { pokeScheduler } from "../push/poke";
import { enqueue } from "../push/scheduler";

/**
 * Sesiones con fases (temporizador por intervalos, meditación, estiramientos).
 * La PWA muestra la cuenta atrás exacta con la pantalla encendida. Con la pantalla
 * bloqueada, iOS no deja correr un temporizador en una web, así que cada cambio de
 * fase se programa como notificación push (Durable Object con alarmas al segundo).
 */

export const MAX_TOTAL_SECONDS = 4 * 3600;
export const MAX_PHASES = 200;

export interface IntervalSpec {
  workSeconds: number;
  restSeconds: number;
  rounds: number;
  workLabel?: string;
  restLabel?: string;
}

/** "30 de estudio, 5 de descanso, 4 veces": sin descanso después de la última ronda. */
export function intervalPhases(spec: IntervalSpec): SessionPhase[] {
  if (spec.workSeconds <= 0 || spec.rounds < 1) throw new Error("Hace falta un tiempo de trabajo y al menos una ronda.");
  const phases: SessionPhase[] = [];
  for (let r = 1; r <= spec.rounds; r++) {
    phases.push({ label: `${spec.workLabel ?? "Trabajo"} ${r}/${spec.rounds}`, seconds: spec.workSeconds, kind: "work" });
    if (r < spec.rounds && spec.restSeconds > 0) {
      phases.push({ label: spec.restLabel ?? "Descanso", seconds: spec.restSeconds, kind: "rest" });
    }
  }
  validatePhases(phases);
  return phases;
}

export function validatePhases(phases: SessionPhase[]): void {
  if (phases.length === 0) throw new Error("La sesión no tiene fases.");
  if (phases.length > MAX_PHASES) throw new Error(`Como mucho ${MAX_PHASES} fases.`);
  const total = phases.reduce((a, p) => a + p.seconds, 0);
  if (total > MAX_TOTAL_SECONDS) throw new Error("Como mucho 4 horas por sesión.");
  if (phases.some((p) => !Number.isInteger(p.seconds) || p.seconds < 5)) throw new Error("Cada fase dura al menos 5 segundos.");
}

export const totalSeconds = (phases: SessionPhase[]) => phases.reduce((a, p) => a + p.seconds, 0);

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** Avisos de cada cambio de fase (y del final) a partir de un instante de inicio. */
export function phaseNotifications(
  session: Pick<WellbeingSession, "id" | "kind" | "title" | "phases">,
  startMs: number,
  fromIndex = 0,
): { key: string; at: number; title: string; body: string }[] {
  const out: { key: string; at: number; title: string; body: string }[] = [];
  let t = startMs;
  const epoch = startMs;
  session.phases.forEach((p, i) => {
    if (i > fromIndex && session.kind !== "meditation") {
      const next = p;
      out.push({
        key: `timer:${session.id}:${epoch}:${i}`,
        at: t,
        title: next.kind === "rest" ? `Descanso · ${fmtDuration(next.seconds)}` : next.kind === "work" ? `¡Vamos! · ${fmtDuration(next.seconds)}` : `Siguiente: ${next.label}`,
        body: next.kind === "step" ? `${next.label} (${fmtDuration(next.seconds)}). ${next.text ?? ""}`.trim() : next.label,
      });
    }
    t += p.seconds * 1000;
  });
  out.push({
    key: `timer:${session.id}:${epoch}:end`,
    at: t,
    title: session.kind === "meditation" ? "Fin de la meditación 🙏" : "¡Terminado! 🎉",
    body: session.kind === "timer" ? `${session.title}: completado.` : session.title,
  });
  return out;
}

interface Row {
  id: string;
  kind: WellbeingSession["kind"];
  title: string;
  phases_json: string;
  started_at: string;
  status: WellbeingSession["status"];
  elapsed_at_pause: number | null;
}

const toSession = (r: Row): WellbeingSession => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  phases: JSON.parse(r.phases_json) as SessionPhase[],
  startedAt: r.started_at,
  status: r.status,
  elapsedAtPause: r.elapsed_at_pause,
});

async function schedule(env: Env, s: WellbeingSession, startMs: number, now: number): Promise<void> {
  for (const n of phaseNotifications(s, startMs)) {
    if (n.at < now - 1000) continue; // fases ya pasadas (al reanudar)
    await enqueue(env.DB, { key: n.key, kind: "timer", at: n.at, title: n.title, body: n.body, url: "/?tab=chat" });
  }
  await pokeScheduler(env);
}

async function cancelNotifications(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE notifications SET status = 'cancelled' WHERE status = 'pending' AND dedupe_key LIKE ?`)
    .bind(`timer:${id}:%`)
    .run();
}

/** Crea y arranca una sesión. Solo hay una activa: la anterior se cancela. */
export async function startSession(
  env: Env,
  input: { kind: WellbeingSession["kind"]; title: string; phases: SessionPhase[] },
  now: number,
): Promise<WellbeingSession> {
  validatePhases(input.phases);
  const { results } = await env.DB.prepare(`SELECT id FROM sessions_wellbeing WHERE status IN ('running', 'paused')`).all<{ id: string }>();
  for (const r of results) await cancelSession(env, r.id);

  const s: WellbeingSession = {
    id: newId("ses"),
    kind: input.kind,
    title: input.title,
    phases: input.phases,
    startedAt: new Date(now).toISOString(),
    status: "running",
    elapsedAtPause: null,
  };
  await env.DB.prepare(
    `INSERT INTO sessions_wellbeing (id, kind, title, phases_json, started_at, status) VALUES (?, ?, ?, ?, ?, 'running')`,
  )
    .bind(s.id, s.kind, s.title, JSON.stringify(s.phases), s.startedAt)
    .run();
  await schedule(env, s, now, now);
  return s;
}

export async function getSession(db: D1Database, id: string): Promise<WellbeingSession | null> {
  const r = await db.prepare(`SELECT * FROM sessions_wellbeing WHERE id = ?`).bind(id).first<Row>();
  return r ? toSession(r) : null;
}

/** Sesión en curso (las que ya terminaron por tiempo se marcan como hechas). */
export async function activeSession(db: D1Database, now: number): Promise<WellbeingSession | null> {
  const r = await db
    .prepare(`SELECT * FROM sessions_wellbeing WHERE status IN ('running', 'paused') ORDER BY created_at DESC LIMIT 1`)
    .first<Row>();
  if (!r) return null;
  const s = toSession(r);
  if (s.status === "running" && Date.parse(s.startedAt) + totalSeconds(s.phases) * 1000 <= now) {
    await db.prepare(`UPDATE sessions_wellbeing SET status = 'done' WHERE id = ?`).bind(s.id).run();
    return null;
  }
  return s;
}

export async function cancelSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE sessions_wellbeing SET status = 'cancelled' WHERE id = ? AND status IN ('running', 'paused')`).bind(id).run();
  await cancelNotifications(env.DB, id);
  await pokeScheduler(env);
}

export async function pauseSession(env: Env, id: string, now: number): Promise<WellbeingSession> {
  const s = await getSession(env.DB, id);
  if (!s || s.status !== "running") throw new Error("No hay una sesión en marcha.");
  const elapsed = Math.floor((now - Date.parse(s.startedAt)) / 1000);
  await env.DB.prepare(`UPDATE sessions_wellbeing SET status = 'paused', elapsed_at_pause = ? WHERE id = ?`).bind(elapsed, id).run();
  await cancelNotifications(env.DB, id);
  await pokeScheduler(env);
  return { ...s, status: "paused", elapsedAtPause: elapsed };
}

export async function resumeSession(env: Env, id: string, now: number): Promise<WellbeingSession> {
  const s = await getSession(env.DB, id);
  if (!s || s.status !== "paused" || s.elapsedAtPause === null) throw new Error("No hay una sesión en pausa.");
  const startMs = now - s.elapsedAtPause * 1000;
  const startedAt = new Date(startMs).toISOString();
  await env.DB.prepare(`UPDATE sessions_wellbeing SET status = 'running', elapsed_at_pause = NULL, started_at = ? WHERE id = ?`)
    .bind(startedAt, id)
    .run();
  const resumed: WellbeingSession = { ...s, status: "running", elapsedAtPause: null, startedAt };
  await schedule(env, resumed, startMs, now);
  return resumed;
}
