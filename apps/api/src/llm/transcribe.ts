import type { LlmProvider } from "./provider";

/**
 * Transcripción de notas de voz. La PWA graba y convierte a WAV (16 kHz, mono),
 * el formato de audio más compatible con las APIs tipo OpenAI (input_audio).
 * No se usa el reconocimiento de voz del navegador: en iOS no es fiable.
 */
export const TRANSCRIBE_PROMPT = [
  "Transcribe this voice note exactly as spoken.",
  "The speaker mixes Spanish and English; keep each word in the language it was said.",
  "Output only the transcription: no quotes, no labels, no comments, no translation.",
  "If there is no intelligible speech, output nothing.",
].join(" ");

export async function transcribe(llm: LlmProvider, wavBase64: string): Promise<string> {
  const res = await llm.chat({
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: TRANSCRIBE_PROMPT },
          { type: "input_audio", input_audio: { data: wavBase64, format: "wav" } },
        ],
      },
    ],
  });
  return (res.content ?? "").replace(/^["'«“]+|["'»”]+$/g, "").trim();
}
