import type { ReactNode } from "react";

export type MoreSection = "money" | "food" | "wellbeing" | "history";

interface Props {
  section: MoreSection;
  onSection(s: MoreSection): void;
  money: ReactNode;
  food: ReactNode;
  wellbeing: ReactNode;
  history: ReactNode;
}

/** Pestaña "Más": dinero, comida, bienestar e historial, para no saturar la barra de pestañas en el móvil. */
export function More({ section, onSection, money, food, wellbeing, history }: Props) {
  return (
    <div className="more">
      <nav className="segmented" role="tablist" aria-label="Secciones">
        {(
          [
            ["money", "Dinero"],
            ["food", "Comida"],
            ["wellbeing", "Bienestar"],
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
        {section === "money" ? money : section === "food" ? food : section === "wellbeing" ? wellbeing : history}
      </div>
    </div>
  );
}
