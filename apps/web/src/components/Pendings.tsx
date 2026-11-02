import type { Pending } from "@marlon/shared";
import { AnimatePresence, motion } from "framer-motion";
import { useMemo } from "react";

interface Props {
  pendings: Pending[];
  today: string;
  busy: string | null;
  onClose(id: string): void;
  onDelete(id: string): void;
}

const AREA: Record<Pending["area"], string> = { work: "Trabajo", uni: "Uni", personal: "Personal" };

function fmtDate(date: string, today: string): string {
  if (date === today) return "hoy";
  const d = new Date(`${date}T12:00:00Z`);
  const t = new Date(`${today}T12:00:00Z`);
  const days = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (days === 1) return "mañana";
  if (days < 0) return days === -1 ? "ayer" : `hace ${-days} días`;
  return new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}

export function Pendings({ pendings, today, busy, onClose, onDelete }: Props) {
  const groups = useMemo(() => {
    const isTodo = (p: Pending) => p.kind === "reminder" || p.kind === "task";
    return [
      { key: "today", label: "Hoy", items: pendings.filter((p) => isTodo(p) && p.dueDate && p.dueDate <= today) },
      { key: "next", label: "Próximos", items: pendings.filter((p) => isTodo(p) && (!p.dueDate || p.dueDate > today)) },
      { key: "short", label: "Planes a corto plazo", items: pendings.filter((p) => p.kind === "plan" && p.horizon !== "long") },
      { key: "long", label: "Planes a largo plazo", items: pendings.filter((p) => p.kind === "plan" && p.horizon === "long") },
      { key: "birthdays", label: "Cumpleaños", items: pendings.filter((p) => p.kind === "birthday") },
    ].filter((g) => g.items.length > 0);
  }, [pendings, today]);

  return (
    <section className="pendings" aria-label="Pendientes">
      <h2>Pendientes</h2>
      {groups.length === 0 && (
        <p className="muted">
          Nada pendiente. Dime cosas como "recuérdame contestar a Mateo" o "el cumple de Laura es el 10 de marzo".
        </p>
      )}
      {groups.map((g) => (
        <div key={g.key} className="pending-group">
          <h3>{g.label}</h3>
          <ul>
            <AnimatePresence initial={false}>
              {g.items.map((p) => {
                const overdue = p.dueDate !== null && p.dueDate < today && p.kind !== "birthday";
                return (
                  <motion.li
                    key={p.id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 40 }}
                    className={overdue ? "overdue" : ""}
                  >
                    <button
                      className="check"
                      aria-label={p.kind === "birthday" ? `Felicitado: ${p.title}` : `Hecho: ${p.title}`}
                      disabled={busy !== null}
                      onClick={() => onClose(p.id)}
                    >
                      {busy === p.id ? "…" : p.kind === "birthday" ? "🎂" : ""}
                    </button>
                    <div className="pending-main">
                      <p>{p.title}</p>
                      <span className="muted small">
                        {[
                          p.dueDate ? `${fmtDate(p.dueDate, today)}${p.dueTime ? ` a las ${p.dueTime}` : ""}` : null,
                          p.kind !== "birthday" ? AREA[p.area] : null,
                          overdue ? "vencido" : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    <button className="icon-btn small-x" aria-label={`Borrar: ${p.title}`} onClick={() => onDelete(p.id)}>
                      ✕
                    </button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </div>
      ))}
    </section>
  );
}
