import type { ReactNode } from "react";

export type MoreSection = "money" | "food" | "wellbeing" | "history";

interface Props {
  section: MoreSection;
  onSection(s: MoreSection): void;
  /** En escritorio la barra lateral ya hace de navegación. */
  hideNav?: boolean;
  money: ReactNode;
  food: ReactNode;
  wellbeing: ReactNode;
  history: ReactNode;
}

const SECTIONS: [MoreSection, string][] = [
  ["money", "Dinero"],
  ["food", "Comida"],
  ["wellbeing", "Bienestar"],
  ["history", "Historial"],
];

/** Pestaña "Más": dinero, comida, bienestar e historial, para no saturar la barra de pestañas en el móvil. */
export function More({ section, onSection, hideNav, money, food, wellbeing, history }: Props) {
  return (
    <div className="more">
      {hideNav ? (
        <header className="section-head">
          <h2>{SECTIONS.find(([k]) => k === section)![1]}</h2>
        </header>
      ) : (
        <nav className="segmented" role="tablist" aria-label="Secciones">
          {SECTIONS.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={section === key} onClick={() => onSection(key)}>
              {label}
            </button>
          ))}
        </nav>
      )}
      {/* key: al cambiar de sección se vuelve arriba. */}
      <div className="more-body" key={section}>
        {section === "money" ? money : section === "food" ? food : section === "wellbeing" ? wellbeing : history}
      </div>
    </div>
  );
}
