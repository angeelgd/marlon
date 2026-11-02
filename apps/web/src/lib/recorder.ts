import { encodeWav, resample, toBase64, toMono } from "./wav";

/**
 * Grabación con botón (pulsar, hablar, soltar). En iOS, MediaRecorder graba en
 * audio/mp4; se decodifica con Web Audio y se convierte a WAV antes de enviarla.
 */

export const MAX_SECONDS = 90;

export interface Recording {
  stop(): Promise<{ wavBase64: string; seconds: number } | null>;
  cancel(): void;
}

function pickMime(): string | undefined {
  for (const m of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return undefined;
}

export async function startRecording(onAutoStop?: () => void): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este navegador no permite grabar audio.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = Date.now();
  rec.start(250);
  const timer = setTimeout(() => onAutoStop?.(), MAX_SECONDS * 1000);

  const finish = () =>
    new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || mime || "audio/mp4" }));
      if (rec.state !== "inactive") rec.stop();
      else resolve(new Blob(chunks));
    }).finally(() => {
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
    });

  return {
    async stop() {
      const blob = await finish();
      const seconds = (Date.now() - started) / 1000;
      if (seconds < 0.6 || blob.size === 0) return null; // toque accidental
      const ctx = new AudioContext();
      try {
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
        const wav = encodeWav(resample(toMono(channels), decoded.sampleRate));
        return { wavBase64: toBase64(wav), seconds };
      } finally {
        void ctx.close();
      }
    },
    cancel() {
      void finish();
    },
  };
}
