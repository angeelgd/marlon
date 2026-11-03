import bienestar from "../../knowledge/bienestar-mente-cuerpo.md";
import entrenamiento from "../../knowledge/entrenamiento.md";
import finanzas from "../../knowledge/finanzas-personales.md";
import nutricion from "../../knowledge/nutricion-vegana.md";
import estudio from "../../knowledge/productividad-estudio.md";
import sueno from "../../knowledge/sueno.md";

/**
 * Base de conocimiento: guías en Markdown (apps/api/knowledge) con fuentes fiables.
 * Empieza simple: sin base de datos vectorial, se elige el documento por palabras
 * clave y se carga entero en el contexto, con sus fuentes para citarlas.
 */

export interface KnowledgeDoc {
  id: string;
  title: string;
  keywords: string[];
  sources: string[];
  body: string;
}

export function parseDoc(id: string, raw: string): KnowledgeDoc {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.replace(/\r\n/g, "\n"));
  if (!m) throw new Error(`El documento ${id} no tiene cabecera.`);
  const head = m[1]!;
  const title = /^title:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? id;
  const keywords = (/^keywords:\s*(.+)$/m.exec(head)?.[1] ?? "")
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const sourcesBlock = /^sources:\s*\n([\s\S]*)$/m.exec(head)?.[1] ?? "";
  const sources = sourcesBlock
    .split("\n")
    .map((l) => /^\s*-\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((s): s is string => Boolean(s));
  return { id, title, keywords, sources, body: m[2]!.trim() };
}

export const KNOWLEDGE: KnowledgeDoc[] = [
  parseDoc("sueno", sueno),
  parseDoc("entrenamiento", entrenamiento),
  parseDoc("nutricion-vegana", nutricion),
  parseDoc("productividad-estudio", estudio),
  parseDoc("finanzas-personales", finanzas),
  parseDoc("bienestar-mente-cuerpo", bienestar),
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Documentos que encajan con el texto, de más a menos relevante. */
export function matchKnowledge(text: string, docs = KNOWLEDGE): { doc: KnowledgeDoc; score: number }[] {
  const t = ` ${norm(text)} `;
  return docs
    .map((doc) => ({
      doc,
      score: doc.keywords.filter((k) => {
        const kw = norm(k);
        return kw.length <= 3 ? new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t) : t.includes(kw);
      }).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function findDoc(topic: string): KnowledgeDoc | null {
  const byId = KNOWLEDGE.find((d) => d.id === topic || norm(d.title) === norm(topic));
  return byId ?? matchKnowledge(topic)[0]?.doc ?? null;
}

/** Bloque para el prompt del sistema con el documento relevante y cómo citarlo. */
export function knowledgePrompt(doc: KnowledgeDoc): string {
  return [
    `Guía de referencia relevante: "${doc.title}". Básate en ella para aconsejar y cita la fuente de cada consejo entre paréntesis, por ejemplo "(Fuente: Watson et al., 2015)". Si algo no está en la guía, dilo y no inventes fuentes.`,
    doc.body,
  ].join("\n\n");
}

export const KNOWLEDGE_INDEX = KNOWLEDGE.map((d) => `${d.id}: ${d.title}`).join("; ");
