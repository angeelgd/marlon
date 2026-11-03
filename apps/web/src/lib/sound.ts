/** Pitidos con Web Audio (sin archivos). iOS exige desbloquear el audio con un toque. */

let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    /* sin audio */
  }
}

function tone(freq: number, startOffset: number, duration: number, volume = 0.2) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  osc.type = "sine";
  const t0 = ctx.currentTime + startOffset;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

/** Cambio de fase: un pitido (más grave para el descanso). */
export function phaseBeep(kind: "work" | "rest" | "step"): void {
  unlockAudio();
  tone(kind === "rest" ? 523 : 880, 0, 0.25);
  if ("vibrate" in navigator) navigator.vibrate?.(150);
}

/** Final: campana suave de tres notas. */
export function endChime(): void {
  unlockAudio();
  tone(660, 0, 0.6, 0.15);
  tone(880, 0.25, 0.6, 0.15);
  tone(1320, 0.5, 1.2, 0.12);
  if ("vibrate" in navigator) navigator.vibrate?.([120, 80, 120]);
}
