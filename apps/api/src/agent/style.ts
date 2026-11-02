/**
 * Ajustes de estilo sobre las respuestas del modelo:
 * - Sin guiones largos ni guiones como signo de puntuación (se cambian por comas).
 * - Botones rápidos: el modelo los escribe al final como [[opciones: A | B]].
 */

export function cleanDashes(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      // Las viñetas de lista al principio de línea se respetan.
      const bullet = /^(\s*)[-–—]\s+/.exec(line);
      const prefix = bullet ? `${bullet[1]}- ` : "";
      let body = bullet ? line.slice(bullet[0].length) : line;
      body = body
        .replace(/\s*[—–]\s*/g, ", ")
        .replace(/(\S)\s+-\s+(?=\S)/g, "$1, ")
        .replace(/,\s*,/g, ",")
        .replace(/,\s*([.!?;:])/g, "$1")
        .replace(/^,\s*/, "");
      return prefix + body;
    })
    .join("\n");
}

const OPTIONS_RE = /\[\[\s*(?:opciones|options)\s*:\s*([^\]]+)\]\]/i;

export function extractQuickReplies(text: string): { text: string; quickReplies: string[] } {
  const m = OPTIONS_RE.exec(text);
  if (!m) return { text: text.trim(), quickReplies: [] };
  const quickReplies = m[1]!
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  return { text: text.replace(OPTIONS_RE, "").trim(), quickReplies };
}

const ES = /\b(el|la|los|las|que|de|qué|cómo|hoy|mañana|tengo|horario|por|para|está|buenos|días|gracias|muévelo|hueco)\b|[ñáéíóú¿¡]/gi;
const EN = /\b(the|what|how|today|tomorrow|have|schedule|for|is|good|morning|thanks|please|move|slot|my|can|you)\b/gi;

/** Idioma probable del mensaje. null si no está claro. */
export function detectLanguage(text: string): "es" | "en" | null {
  const es = text.match(ES)?.length ?? 0;
  const en = text.match(EN)?.length ?? 0;
  if (es === en) return null;
  return es > en ? "es" : "en";
}

export function polish(raw: string): { text: string; quickReplies: string[] } {
  const { text, quickReplies } = extractQuickReplies(raw);
  return { text: cleanDashes(text), quickReplies: quickReplies.map(cleanDashes) };
}
