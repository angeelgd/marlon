import type { ChangeLogEntry } from "@marlon/shared";
import { useMemo } from "react";

interface Props {
  entries: ChangeLogEntry[];
  busy: string | null;
  onUndo(id: string): void;
}

const ICON: Record<ChangeLogEntry["action"], string> = { create: "＋", move: "⇄", update: "✎", delete: "✕" };

/** Agrupa los cambios de un mismo grupo (p. ej. una importación de horario). */
function group(entries: ChangeLogEntry[]) {
  const out: { key: string; items: ChangeLogEntry[] }[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (e.groupId && prev && prev.items[0]!.groupId === e.groupId) prev.items.push(e);
    else out.push({ key: e.groupId ?? e.id, items: [e] });
  }
  return out;
}

export function History({ entries, busy, onUndo }: Props) {
  const groups = useMemo(() => group(entries), [entries]);
  const fmt = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <section className="history" aria-label="Historial de cambios">
      <h2>Historial</h2>
      {groups.length === 0 && <p className="muted">Aún no hay cambios.</p>}
      <ul>
        {groups.map(({ key, items }) => {
          const head = items[0]!;
          const undone = items.every((i) => i.undoneAt);
          return (
            <li key={key} className={undone ? "undone" : ""}>
              <div className="history-main">
                <span className="history-icon" aria-hidden>
                  {items.length > 1 ? "▤" : ICON[head.action]}
                </span>
                <div>
                  {items.length > 1 ? (
                    <details>
                      <summary>{items.length} cambios a la vez</summary>
                      <ul className="history-sub">
                        {items.map((i) => (
                          <li key={i.id}>{i.summary}</li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <p>{head.summary}</p>
                  )}
                  <time className="muted">{fmt.format(new Date(head.createdAt))}</time>
                </div>
              </div>
              {undone ? (
                <span className="muted small">Deshecho</span>
              ) : (
                <button className="btn ghost small" disabled={busy !== null} onClick={() => onUndo(head.id)}>
                  {busy === head.id ? "…" : "Deshacer"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
