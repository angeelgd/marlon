import { useEffect, useRef, useState } from "react";
import { MAX_SECONDS, startRecording, type Recording } from "../lib/recorder";
import { stopSpeaking, unlockSpeech } from "../lib/speech";

interface Props {
  disabled: boolean;
  onAudio(wavBase64: string): void;
  onError(message: string): void;
}

/**
 * Pulsar, hablar y soltar. Deslizar hacia arriba cancela.
 * Nada de modo llamada: cada nota de voz es un mensaje.
 */
export function VoiceButton({ disabled, onAudio, onError }: Props) {
  const [state, setState] = useState<"idle" | "starting" | "recording" | "processing">("idle");
  const [seconds, setSeconds] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const rec = useRef<Recording | null>(null);
  const startY = useRef(0);
  const released = useRef(false);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (tick.current) clearInterval(tick.current);
    rec.current?.cancel();
  }, []);

  async function finish(cancel: boolean) {
    if (tick.current) clearInterval(tick.current);
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    if (cancel) {
      r.cancel();
      setState("idle");
      return;
    }
    setState("processing");
    try {
      const out = await r.stop();
      if (out) onAudio(out.wavBase64);
    } catch (err) {
      onError(`No he podido procesar el audio: ${(err as Error).message}`);
    } finally {
      setState("idle");
    }
  }

  async function begin(e: React.PointerEvent<HTMLButtonElement>) {
    if (disabled || state !== "idle") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startY.current = e.clientY;
    released.current = false;
    setCancelling(false);
    setSeconds(0);
    stopSpeaking();
    unlockSpeech(); // iOS: así luego puede hablar la respuesta
    setState("starting");
    try {
      rec.current = await startRecording(() => void finish(false));
    } catch (err) {
      setState("idle");
      onError(
        (err as Error).name === "NotAllowedError"
          ? "Necesito permiso para usar el micrófono."
          : `No puedo grabar: ${(err as Error).message}`,
      );
      return;
    }
    // Si ya soltó mientras pedíamos el micro, se descarta.
    if (released.current) return void finish(true);
    setState("recording");
    const t0 = Date.now();
    tick.current = setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 250);
  }

  return (
    <>
      {(state === "recording" || state === "starting") && (
        <div className={`recording-bar ${cancelling ? "cancel" : ""}`} role="status">
          <span className="rec-dot" />
          {cancelling ? "Suelta para cancelar" : `Grabando ${seconds}s, suelta para enviar`}
          <span className="muted small"> (máx. {MAX_SECONDS}s, desliza arriba para cancelar)</span>
        </div>
      )}
      <button
        type="button"
        className={`mic-btn ${state}`}
        aria-label="Mantén pulsado para hablar"
        disabled={disabled || state === "processing"}
        onPointerDown={begin}
        onPointerMove={(e) => state === "recording" && setCancelling(startY.current - e.clientY > 70)}
        onPointerUp={() => {
          released.current = true;
          if (state === "recording") void finish(cancelling);
        }}
        onPointerCancel={() => {
          released.current = true;
          void finish(true);
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {state === "processing" ? "…" : "🎙"}
      </button>
    </>
  );
}
