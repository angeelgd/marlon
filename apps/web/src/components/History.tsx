import type { ChangeLogEntry } from "@marlon/shared";
import { ArrowLeftRight, Layers, Pencil, Plus, Trash2, History as HistoryIcon, type LucideIcon } from "lucide-react";
import { useMemo } from "react";

interface Props {
  entries: ChangeLogEntry[];
  busy: string | null;
  onUndo(id: string): void;
}

const ICON: Record<ChangeLogEntry["action"], LucideIcon> = { create: Plus, move: ArrowLeftRight, update: Pencil, delete: Trash2 };

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
      <div className="stack">
        {groups.length === 0 ? (
          <div className="empty">
            <HistoryIcon size={28} strokeWidth={1.5} />
            <h3>Sin cambios todavía</h3>
            <p>Cada cambio que haga Marlon en tu calendario aparecerá aquí y podrás deshacerlo.</p>
          </div>
        ) : (
          <ul className="list">
            {groups.map(({ key, items }) => {
              const head = items[0]!;
              const undone = items.every((i) => i.undoneAt);
              const Icon = items.length > 1 ? Layers : ICON[head.action];
              return (
                <li key={key} className={undone ? "undone" : ""}>
                  <span className="list-lead" aria-hidden>
                    <Icon size={16} strokeWidth={1.75} />
                  </span>
                  <div className="list-main">
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
                    <div className="meta">{fmt.format(new Date(head.createdAt))}</div>
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
        )}
      </div>
    </section>
  );
}
