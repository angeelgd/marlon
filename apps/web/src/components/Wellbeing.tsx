import type { Book } from "@marlon/shared";
import { useCallback, useEffect, useState } from "react";
import { api, type ReadingData } from "../lib/api";

interface Props {
  onStart(kind: "meditation" | "stretch", opt: number | "post_gym" | "desk"): void;
  onAsk(text: string): void;
  onToast(text: string): void;
}

const fmtDate = (d: string) => new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
const stars = (n: number | null) => (n ? "★".repeat(n) + "☆".repeat(5 - n) : "");

export function Wellbeing({ onStart, onAsk, onToast }: Props) {
  const [data, setData] = useState<ReadingData | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.reading());
    } catch (err) {
      onToast((err as Error).message);
    }
  }, [onToast]);
  useEffect(() => {
    void load();
  }, [load]);

  const cur = data?.current ?? null;
  const est = data?.estimate ?? null;
  const past = (data?.books ?? []).filter((b: Book) => b.status !== "reading");

  return (
    <section className="wellbeing" aria-label="Bienestar">
      <div className="card">
        <h3>Para un respiro</h3>
        <div className="actions-row">
          <button className="btn small" onClick={() => onStart("meditation", 3)}>Meditar 3 min</button>
          <button className="btn small" onClick={() => onStart("meditation", 5)}>5 min</button>
          <button className="btn small" onClick={() => onStart("meditation", 10)}>10 min</button>
        </div>
        <div className="actions-row">
          <button className="btn ghost small" onClick={() => onStart("stretch", "post_gym")}>Estirar tras el gimnasio</button>
          <button className="btn ghost small" onClick={() => onStart("stretch", "desk")}>Estirar tras programar</button>
        </div>
        <p className="muted small">Para un temporizador, díselo a Marlon: «40 segundos de ejercicio, 20 de descanso, 8 rondas».</p>
      </div>

      <div className="card">
        <h3>Leyendo</h3>
        {!cur && (
          <>
            <p className="muted small">Ningún libro en marcha.</p>
            <div className="actions-row">
              <button className="btn small" onClick={() => onAsk("¿Qué libro me recomiendas para empezar?")}>Recomiéndame uno</button>
            </div>
          </>
        )}
        {cur && (
          <>
            <p className="book-title">{cur.title}{cur.author ? <span className="muted small"> · {cur.author}</span> : null}</p>
            <div className="bar"><div style={{ width: `${cur.percent}%` }} /></div>
            <p className="small">
              {cur.percent} %
              {est?.remainingTrips ? ` · unos ${est.remainingTrips} trayectos en bus más` : ""}
              {est?.finishDate ? ` · lo terminarías el ${fmtDate(est.finishDate)}` : ""}
            </p>
            {!est?.pacePerTrip && <p className="muted small">Cuando le digas un par de veces «voy por el X %» al acabar un trayecto, calculará cuándo lo terminas.</p>}
            <div className="actions-row">
              {[10, 25, 50, 75].filter((p) => p > cur.percent).slice(0, 2).map((p) => (
                <button key={p} className="btn ghost small" onClick={() => onAsk(`voy por el ${p} %`)}>Voy por el {p} %</button>
              ))}
              <button className="btn ghost small" onClick={() => onAsk("He terminado el libro")}>Lo he terminado</button>
            </div>
          </>
        )}
      </div>

      {past.length > 0 && (
        <div className="card">
          <h3>Leídos</h3>
          <ul className="recipe-list">
            {past.map((b) => (
              <li key={b.id}>
                <span>{b.title}</span> <span className="stars">{stars(b.rating)}</span>
                {b.status === "abandoned" && <span className="muted small"> · abandonado</span>}
                {b.opinion && <p className="small muted">“{b.opinion}”</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
