import type { ReactNode } from "react";

export type MoreSection = "money" | "food" | "history";

interface Props {
  section: MoreSection;
  onSection(s: MoreSection): void;
  money: ReactNode;
  food: ReactNode;
  history: ReactNode;
}

/** Pestaña "Más": dinero, comida e historial, para no saturar la barra de pestañas en el móvil. */
export function More({ section, onSection, money, food, history }: Props) {
  return (
    <div className="more">
      <nav className="segmented" role="tablist" aria-label="Secciones">
        {(
          [
            ["money", "Dinero"],
            ["food", "Comida"],
            ["history", "Historial"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={section === key} onClick={() => onSection(key)}>
            {label}
          </button>
        ))}
      </nav>
      {/* key: al cambiar de sección se vuelve arriba. */}
      <div className="more-body" key={section}>
        {section === "money" ? money : section === "food" ? food : history}
      </div>
    </div>
  );
}
