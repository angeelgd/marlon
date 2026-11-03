import { ChevronDown } from "lucide-react";
import { sessionPosition, type WellbeingSession } from "@marlon/shared";
import { useEffect, useRef, useState } from "react";
import { endChime, phaseBeep } from "../lib/sound";
import { speak, stopSpeaking } from "../lib/speech";

interface Props {
  session: WellbeingSession;
  textOnly: boolean;
  voice: "browser" | "provider";
  onPause(): void;
  onResume(): void;
  onStop(): void;
  onDone(): void;
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Cuenta atrás exacta con la pantalla encendida (se pide Wake Lock). Con la
 * pantalla bloqueada, los avisos de cada fase llegan como notificación push.
 */
export function SessionPlayer({ session, textOnly, voice, onPause, onResume, onStop, onDone }: Props) {
  const [now, setNow] = useState(Date.now());
  const [minimized, setMinimized] = useState(false);
  const lastIndex = useRef<number | null>(null);
  const finished = useRef(false);

  const total = session.phases.reduce((a, p) => a + p.seconds, 0);
  const elapsed = session.status === "paused" ? (session.elapsedAtPause ?? 0) : (now - Date.parse(session.startedAt)) / 1000;
  const pos = sessionPosition(session.phases, Math.max(0, elapsed));
  const phase = pos ? session.phases[pos.index]! : null;
  const next = pos ? session.phases[pos.index + 1] : null;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Mantener la pantalla encendida mientras corre.
  useEffect(() => {
    if (session.status !== "running" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const request = () =>
      navigator.wakeLock
        .request("screen")
        .then((l) => {
          if (cancelled) void l.release();
          else lock = l;
        })
        .catch(() => {});
    void request();
    const onVisible = () => document.visibilityState === "visible" && void request();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [session.status, session.id]);

  // Cambios de fase: pitido y, en las sesiones guiadas, se lee el texto.
  useEffect(() => {
    if (session.status !== "running") return;
    if (!pos) {
      if (!finished.current) {
        finished.current = true;
        if (!textOnly) endChime();
        setTimeout(onDone, 2500);
      }
      return;
    }
    if (lastIndex.current === pos.index) return;
    const first = lastIndex.current === null;
    lastIndex.current = pos.index;
    // Al abrir a mitad de una fase no se repite el aviso.
    if (first && pos.phaseElapsed > 2) return;
    if (textOnly) return;
    if (!first) phaseBeep(phase!.kind);
    if (phase?.text) void speak(phase.text, "es", voice);
  }, [pos?.index, pos === null, session.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => stopSpeaking(), []);

  const progress = Math.min(1, Math.max(0, elapsed / total));

  if (minimized) {
    return (
      <button className="session-pill" onClick={() => setMinimized(false)} aria-label="Abrir sesión">
        <span className={`dot ${phase?.kind ?? "work"}`} />
        {phase ? `${phase.label} · ${mmss(pos!.remaining)}` : "Terminado"}
      </button>
    );
  }

  return (
    <div className={`session ${session.kind} ${phase?.kind ?? "done"}`} role="dialog" aria-label={session.title}>
      <header>
        <span className="muted small">{session.title}</span>
        <button className="icon-btn" onClick={() => setMinimized(true)} aria-label="Minimizar"><ChevronDown size={20} strokeWidth={1.75} /></button>
      </header>
      <div className="session-main">
        {phase ? (
          <>
            <p className="session-phase">{phase.label}</p>
            <p className="session-time">{mmss(pos!.remaining)}</p>
            {phase.text && <p className="session-text">{phase.text}</p>}
            {next && <p className="muted small">Después: {next.label} ({mmss(next.seconds)})</p>}
          </>
        ) : (
          <>
            <p className="session-phase">Sesión completada</p>
            <p className="session-time session-done">Hecho</p>
          </>
        )}
      </div>
      <div className="session-progress" aria-hidden>
        <div style={{ width: `${progress * 100}%` }} />
      </div>
      <p className="muted small center">
        {pos ? `Fase ${pos.index + 1} de ${session.phases.length} · quedan ${mmss(total - elapsed)}` : ""}
        {textOnly ? " · modo solo texto: sin sonido" : ""}
      </p>
      <div className="session-actions">
        {session.status === "running" ? (
          <button className="btn ghost" onClick={onPause} disabled={!pos}>Pausa</button>
        ) : (
          <button className="btn" onClick={onResume}>Seguir</button>
        )}
        <button className="btn ghost" onClick={onStop}>Terminar</button>
      </div>
    </div>
  );
}
