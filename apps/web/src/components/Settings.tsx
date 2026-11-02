import type { Settings as S } from "@marlon/shared";
import { useState } from "react";

interface Props {
  settings: S;
  calendarBackend: "google" | "local";
  onSave(patch: Partial<S>): Promise<void>;
  onClose(): void;
  onLogout(): void;
}

export function Settings({ settings, calendarBackend, onSave, onClose, onLogout }: Props) {
  const [draft, setDraft] = useState<S>(settings);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const field = <K extends keyof S>(key: K) => ({
    value: draft[key] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: e.target.value }),
  });
  const check = <K extends keyof S>(key: K) => ({
    checked: draft[key] as boolean,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: e.target.checked }),
  });

  return (
    <div className="modal" role="dialog" aria-label="Ajustes">
      <form
        className="modal-card settings"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setMsg(null);
          try {
            await onSave(draft);
            setMsg("Guardado.");
          } catch (err) {
            setMsg((err as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <header>
          <h2>Ajustes</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">✕</button>
        </header>

        <p className={`badge ${calendarBackend}`}>
          {calendarBackend === "google"
            ? "Conectado a Google Calendar"
            : "Modo local: sin Google Calendar (configura los secretos de Google para conectarlo)"}
        </p>

        <fieldset>
          <legend>Horario de trabajo</legend>
          <label>Columna en la foto<input {...field("scheduleColumnName")} required /></label>
          <label>Título de los turnos<input {...field("workEventTitle")} required /></label>
          <label className="row">
            <input type="checkbox" {...check("autoConfirmCleanSchedule")} />
            Guardar solo si no hay dudas (y avisarme después)
          </label>
          <label className="row">
            <input type="checkbox" {...check("allowFreeTierForSchedulePhoto")} />
            Permitir enviar la foto por la capa gratuita del modelo (incluye datos de compañeros)
          </label>
        </fieldset>

        <fieldset>
          <legend>Calendario</legend>
          <label>ID del calendario de Google<input {...field("googleCalendarId")} required /></label>
          <label>Zona horaria<input {...field("timezone")} required /></label>
          <div className="row2">
            <label>Empieza el día<input type="time" {...field("dayStart")} required /></label>
            <label>Acaba el día<input type="time" {...field("dayEnd")} required /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Lugares (solo aquí, nunca en el código)</legend>
          <label>Casa<input {...field("homeAddress")} autoComplete="off" /></label>
          <label>Trabajo<input {...field("workLocation")} autoComplete="off" /></label>
          <label>Universidad<input {...field("universityAddress")} autoComplete="off" /></label>
          <label>Gimnasio<input {...field("gymAddress")} autoComplete="off" /></label>
        </fieldset>

        {msg && <p className="muted">{msg}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onLogout}>Cerrar sesión</button>
          <button type="submit" className="btn" disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button>
        </div>
      </form>
    </div>
  );
}
