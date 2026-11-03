import type { Memory } from "@marlon/shared";
import { newId, nowIso } from "../lib/ids";
import { looksFinancial } from "../money/sensitivity";

/**
 * Memoria de Marlon: lo que va aprendiendo (gustos, rutinas, preferencias de horario).
 * Se puede ver, editar y borrar desde los ajustes. Lo que parece económico se marca
 * como sensible y no se envía por la capa gratuita.
 */

export const MEMORY_CATEGORIES = ["preference", "routine", "person", "health", "reading", "other"] as const;

interface Row {
  id: string;
  content: string;
  category: Memory["category"];
  sensitive: number;
  created_at: string;
  updated_at: string;
}

const toMemory = (r: Row): Memory => ({ id: r.id, content: r.content, category: r.category, createdAt: r.created_at, updatedAt: r.updated_at });

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export async function listMemories(db: D1Database, opts: { includeSensitive?: boolean } = {}): Promise<Memory[]> {
  const { results } = await db
    .prepare(`SELECT * FROM memories WHERE (?1 = 1 OR sensitive = 0) ORDER BY category, updated_at DESC`)
    .bind(opts.includeSensitive === false ? 0 : 1)
    .all<Row>();
  return results.map(toMemory);
}

/** Guarda un recuerdo; si ya hay uno casi igual, lo actualiza en vez de duplicarlo. */
export async function remember(db: D1Database, content: string, category: Memory["category"] = "other"): Promise<{ memory: Memory; updated: boolean }> {
  const text = content.trim();
  if (text.length < 3) throw new Error("Eso es demasiado corto para recordarlo.");
  if (text.length > 500) throw new Error("Resúmelo un poco (máximo 500 caracteres).");
  const all = await listMemories(db);
  const words = new Set(norm(text).split(" ").filter((w) => w.length > 3));
  const similar = all.find((m) => {
    const mw = norm(m.content).split(" ").filter((w) => w.length > 3);
    if (mw.length === 0 || words.size === 0) return false;
    const common = mw.filter((w) => words.has(w)).length;
    return common / Math.max(mw.length, words.size) >= 0.7;
  });
  const sensitive = looksFinancial(text) ? 1 : 0;
  if (similar) {
    await db.prepare(`UPDATE memories SET content = ?, category = ?, sensitive = ?, updated_at = ? WHERE id = ?`)
      .bind(text, category, sensitive, nowIso(), similar.id)
      .run();
    return { memory: { ...similar, content: text, category }, updated: true };
  }
  const id = newId("mem");
  await db.prepare(`INSERT INTO memories (id, content, category, sensitive) VALUES (?, ?, ?, ?)`).bind(id, text, category, sensitive).run();
  return { memory: toMemory((await db.prepare(`SELECT * FROM memories WHERE id = ?`).bind(id).first<Row>())!), updated: false };
}

export async function updateMemory(db: D1Database, id: string, content: string, category?: Memory["category"]): Promise<void> {
  const r = await db
    .prepare(`UPDATE memories SET content = ?, category = COALESCE(?, category), sensitive = ?, updated_at = ? WHERE id = ?`)
    .bind(content.trim(), category ?? null, looksFinancial(content) ? 1 : 0, nowIso(), id)
    .run();
  if ((r.meta.changes ?? 0) === 0) throw new Error("Ese recuerdo no existe.");
}

export async function forget(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare(`DELETE FROM memories WHERE id = ?`).bind(id).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function findMemories(db: D1Database, query: string): Promise<Memory[]> {
  const words = norm(query).split(" ").filter((w) => w.length > 3);
  if (!words.length) return [];
  return (await listMemories(db)).filter((m) => {
    const t = norm(m.content);
    return words.filter((w) => t.includes(w)).length / words.length >= 0.5;
  });
}

const LABEL: Record<Memory["category"], string> = {
  preference: "Gustos y preferencias",
  routine: "Rutinas",
  person: "Personas",
  health: "Salud",
  reading: "Lectura",
  other: "Otros",
};

/** Bloque para el prompt del sistema. */
export function memoryPrompt(memories: Memory[], max = 60): string {
  if (memories.length === 0) return "";
  const groups = new Map<string, string[]>();
  for (const m of memories.slice(0, max)) {
    const list = groups.get(LABEL[m.category]) ?? [];
    list.push(`- ${m.content} [${m.id}]`);
    groups.set(LABEL[m.category], list);
  }
  return ["Lo que sabes de Ángel (memoria; puedes actualizarla con remember_fact o borrarla con forget_fact):", ...[...groups].map(([k, v]) => `${k}:\n${v.join("\n")}`)].join("\n");
}
