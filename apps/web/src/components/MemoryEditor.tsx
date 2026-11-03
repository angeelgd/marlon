import { Pencil, X } from "lucide-react";
import type { Memory } from "@marlon/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

const CATS: { value: Memory["category"]; label: string }[] = [
  { value: "preference", label: "Gustos" },
  { value: "routine", label: "Rutinas" },
  { value: "person", label: "Personas" },
  { value: "health", label: "Salud" },
  { value: "reading", label: "Lectura" },
  { value: "other", label: "Otros" },
];

/** "Lo que Marlon sabe de ti": ver, editar y borrar la memoria. */
export function MemoryEditor() {
  const [items, setItems] = useState<Memory[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [fresh, setFresh] = useState("");
  const [cat, setCat] = useState<Memory["category"]>("preference");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setItems((await api.memories()).memories), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="memory">
      {items.length === 0 && <p className="muted small">Aún no ha guardado nada. Irá aprendiendo tus gustos y rutinas.</p>}
      <ul>
        {items.map((m) => (
          <li key={m.id}>
            {editing === m.id ? (
              <div className="inline-form">
                <input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Editar recuerdo" />
                <button type="button" className="btn small" onClick={() => run(() => api.updateMemory(m.id, draft)).then(() => setEditing(null))}>Guardar</button>
                <button type="button" className="btn ghost small" onClick={() => setEditing(null)}>Cancelar</button>
              </div>
            ) : (
              <>
                <span className="mem-cat">{CATS.find((c) => c.value === m.category)?.label}</span>
                <span className="mem-text">{m.content}</span>
                <button type="button" className="icon-btn sm quiet" aria-label="Editar" onClick={() => (setEditing(m.id), setDraft(m.content))}><Pencil size={15} strokeWidth={1.75} /></button>
                <button type="button" className="icon-btn sm quiet" aria-label="Borrar" onClick={() => run(() => api.deleteMemory(m.id))}><X size={15} strokeWidth={1.75} /></button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="inline-form">
        <select value={cat} onChange={(e) => setCat(e.target.value as Memory["category"])} aria-label="Tipo">
          {CATS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <input placeholder="Algo que deba saber de ti" value={fresh} onChange={(e) => setFresh(e.target.value)} aria-label="Nuevo recuerdo" />
        <button
          type="button"
          className="btn small"
          disabled={fresh.trim().length < 3}
          onClick={() => run(() => api.addMemory(fresh.trim(), cat)).then(() => setFresh(""))}
        >
          Añadir
        </button>
      </div>
      {error && <p className="chat-error">{error}</p>}
    </div>
  );
}
