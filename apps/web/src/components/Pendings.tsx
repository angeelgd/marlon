import type { Pending } from "@marlon/shared";
import { AnimatePresence, motion } from "framer-motion";
import { Cake, Check, Inbox, Loader2, X } from "lucide-react";
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
  if (date === today) return "Hoy";
  const d = new Date(`${date}T12:00:00Z`);
  const t = new Date(`${today}T12:00:00Z`);
  const days = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (days === 1) return "Mañana";
  if (days < 0) return days === -1 ? "Ayer" : `Hace ${-days} días`;
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
    <section className="pendings scroll" aria-label="Pendientes">
      <header className="section-head desk-only">
        <h2>Pendientes</h2>
      </header>
      <div className="stack">
        {groups.length === 0 && (
          <div className="empty">
            <Inbox size={28} strokeWidth={1.5} />
            <h3>Todo al día</h3>
            <p>Dile a Marlon cosas como «recuérdame contestar a Mateo» o «el cumple de Laura es el 10 de marzo».</p>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <h3 className="eyebrow group-title">
              {g.label} <span className="num">· {g.items.length}</span>
            </h3>
            <ul className="list">
              <AnimatePresence initial={false}>
                {g.items.map((p) => {
                  const overdue = p.dueDate !== null && p.dueDate < today && p.kind !== "birthday";
                  const birthday = p.kind === "birthday";
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
                        className={`check ${birthday ? "gift" : ""} ${busy === p.id ? "busy" : ""}`}
                        aria-label={birthday ? `Felicitado: ${p.title}` : `Hecho: ${p.title}`}
                        disabled={busy !== null}
                        onClick={() => onClose(p.id)}
                      >
                        {busy === p.id ? (
                          <Loader2 size={13} className="spin" />
                        ) : birthday ? (
                          <Cake size={13} strokeWidth={1.75} />
                        ) : (
                          <Check size={13} strokeWidth={2.5} className="check-mark" />
                        )}
                      </button>
                      <div className="list-main">
                        <p>{p.title}</p>
                        <div className="meta">
                          {[
                            p.dueDate ? `${fmtDate(p.dueDate, today)}${p.dueTime ? `, ${p.dueTime}` : ""}` : null,
                            !birthday ? AREA[p.area] : null,
                            overdue ? "Vencido" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <button className="icon-btn sm quiet" aria-label={`Borrar: ${p.title}`} onClick={() => onDelete(p.id)}>
                        <X size={16} strokeWidth={1.75} />
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
