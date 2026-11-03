/**
 * Respuestas habladas. Por defecto, la síntesis de voz del navegador (gratis);
 * opcionalmente, la voz del proveedor (/api/tts). En modo solo texto, nada.
 */

let audio: HTMLAudioElement | null = null;

/** iOS solo deja hablar después de un gesto: se "desbloquea" al pulsar el micro. */
export function unlockSpeech(): void {
  try {
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
    audio ??= new Audio();
    audio.muted = true;
    void audio.play().catch(() => {});
    audio.muted = false;
  } catch {
    /* no pasa nada */
  }
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
}

/** Quita emojis y símbolos que suenan raro leídos en voz alta. */
export function speakable(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickVoice(lang: "es" | "en"): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const prefs = lang === "es" ? ["es-ES", "es-MX", "es-US", "es"] : ["en-GB", "en-US", "en"];
  for (const p of prefs) {
    const v = voices.find((v) => v.lang.replace("_", "-").startsWith(p) && v.localService) ?? voices.find((v) => v.lang.replace("_", "-").startsWith(p));
    if (v) return v;
  }
  return undefined;
}

function speakBrowser(text: string, lang: "es" | "en"): void {
  if (!("speechSynthesis" in window)) return;
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === "es" ? "es-ES" : "en-GB";
  const v = pickVoice(lang);
  if (v) u.voice = v;
  u.rate = 1.03;
  speechSynthesis.speak(u);
}

export async function speak(text: string, lang: "es" | "en", mode: "browser" | "provider"): Promise<void> {
  const clean = speakable(text);
  if (!clean) return;
  if (mode === "provider") {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: clean, lang }),
      });
      if (res.ok) {
        stopSpeaking();
        audio ??= new Audio();
        audio.src = URL.createObjectURL(await res.blob());
        await audio.play();
        return;
      }
    } catch {
      /* si falla, se usa la voz del navegador */
    }
  }
  speakBrowser(clean, lang);
}
