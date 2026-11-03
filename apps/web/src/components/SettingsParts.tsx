import type { ReactNode } from "react";

export function Group({ id, title, foot, children }: { id: string; title: string; foot?: ReactNode; children: ReactNode }) {
  return (
    <section className="s-group" id={id}>
      <h3 className="eyebrow">{title}</h3>
      <div className="s-list">{children}</div>
      {foot && <p className="s-foot">{foot}</p>}
    </section>
  );
}

export function Label({ title, hint }: { title: string; hint?: string }) {
  return (
    <span className="s-label">
      {title}
      {hint && <small>{hint}</small>}
    </span>
  );
}

