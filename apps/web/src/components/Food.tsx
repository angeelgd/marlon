import { useCallback, useEffect, useState } from "react";
import { api, type FoodData } from "../lib/api";

interface Props {
  onAsk(text: string): void;
  onToast(text: string): void;
}

const dayLabel = (date: string) =>
  new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const qty = (q: number | null, u: string | null) => [q ?? "", u ?? ""].join(" ").trim();

export function Food({ onAsk, onToast }: Props) {
  const [data, setData] = useState<FoodData | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.food());
    } catch (err) {
      onToast((err as Error).message);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <section className="food"><p className="muted">Cargando…</p></section>;
  const plan = data.plan;

  async function toggle(name: string, checked: boolean) {
    if (!plan) return;
    setData((d) =>
      d && d.plan
        ? {
            ...d,
            plan: {
              ...d.plan,
              shopping: d.plan.shopping.map((g) => ({ ...g, items: g.items.map((i) => (i.name === name ? { ...i, checked } : i)) })),
            },
          }
        : d,
    );
    await api.toggleShopping(plan.weekStart, name, checked).catch((err: Error) => onToast(err.message));
  }

  return (
    <section className="food" aria-label="Comida">
      <div className="actions-row">
        <button className="btn small" onClick={() => onAsk("Propónme vídeos de batch cooking para esta semana")}>Buscar ideas de batch cooking</button>
        {data.recipes.length > 0 && (
          <button className="btn ghost small" onClick={() => onAsk("Hazme el menú y la lista de la compra con las últimas recetas")}>Rehacer el menú</button>
        )}
      </div>

      {!plan && <p className="muted">Aún no hay menú. Pídeme ideas de batch cooking y te armo el menú y la lista de la compra.</p>}

      {plan && (
        <>
          <div className="card">
            <h3>Menú de la semana del {dayLabel(plan.weekStart)}</h3>
            <p className="muted small">Se cocina el {dayLabel(plan.plan.cookDate)}.</p>
            <ul className="menu-list">
              {plan.plan.days.map((d) => (
                <li key={d.date}>
                  <b>{dayLabel(d.date)}</b>
                  <span className="small">Comida: {d.lunch ? `${d.lunch.recipe}${d.lunch.fromFreezer ? " ❄" : ""}` : "libre"}</span>
                  <span className="small">Cena: {d.dinner ? `${d.dinner.recipe}${d.dinner.fromFreezer ? " ❄" : ""}` : "libre"}</span>
                  {d.note && <span className="small tip">{d.note}</span>}
                </li>
              ))}
            </ul>
            {plan.plan.budget?.message && <p className="small">{plan.plan.budget.message}</p>}
          </div>

          <div className="card">
            <h3>Lista de la compra</h3>
            {plan.shopping.map((g) => (
              <div key={g.category} className="shop-group">
                <h4>{g.label}</h4>
                <ul>
                  {g.items.map((i) => (
                    <li key={i.name}>
                      <label className={i.checked ? "done" : ""}>
                        <input type="checkbox" checked={Boolean(i.checked)} onChange={(e) => void toggle(i.name, e.target.checked)} />
                        <span>{i.name}</span>
                        <span className="muted small">{qty(i.quantity, i.unit)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="card">
            <h3>Nutrición</h3>
            {plan.plan.nutrition.protein_per_day_g !== null && (
              <p className="small">
                Proteína del batch cooking: unos {plan.plan.nutrition.protein_per_day_g} g al día
                {plan.plan.nutrition.protein_target_g ? ` (objetivo ~${plan.plan.nutrition.protein_target_g} g)` : ""}.
              </p>
            )}
            {plan.plan.nutrition.warnings.map((w) => <p key={w} className="small tip">{w}</p>)}
            <ul className="small notes">{plan.plan.nutrition.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            <p className="muted small">{plan.plan.nutrition.disclaimer}</p>
          </div>
        </>
      )}

      {data.recipes.length > 0 && (
        <div className="card">
          <h3>Recetas guardadas</h3>
          <ul className="recipe-list">
            {data.recipes.map((r) => (
              <li key={r.videoId}>
                <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a>
                <span className="muted small"> {r.channel} · {r.recipe.servings} raciones{r.source === "description" ? " · desde la descripción" : ""}</span>
                <p className="small">{r.recipe.highlights}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
