import type { Settings as S } from "@marlon/shared";
import { useState } from "react";

interface Props {
  settings: S;
  calendarBackend: "google" | "local";
  onSave(patch: Partial<S>): Promise<void>;
  onClose(): void;
  onLogout(): void;
  /** Acciones rápidas; devuelven un texto para mostrar. */
  onSyncUniversity(): Promise<string>;
  onReplanGym(): Promise<string>;
}

export function Settings({ settings, calendarBackend, onSave, onClose, onLogout, onSyncUniversity, onReplanGym }: Props) {
  const [draft, setDraft] = useState<S>(settings);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const field = <K extends keyof S>(key: K) => ({
    value: draft[key] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: e.target.value }),
  });
  const num = <K extends keyof S>(key: K, opts: { min?: number; max?: number; step?: number } = {}) => ({
    type: "number",
    inputMode: "decimal" as const,
    value: String(draft[key]),
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: Number(e.target.value) }),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const action = async (name: string, fn: () => Promise<string>) => {
    setBusy(name);
    setMsg(null);
    try {
      setMsg(await fn());
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
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

        <fieldset>
          <legend>Sueño y rutina</legend>
          <div className="row2">
            <label>Horas de sueño (mín. 8)<input {...num("sleepHours", { min: 8, max: 12, step: 0.5 })} /></label>
            <label>Levantarse en días libres<input type="time" {...field("freeDayWake")} required /></label>
            <label>Rutina de mañana (min)<input {...num("morningRoutineMin", { min: 0, max: 180 })} /></label>
            <label>Relajarse antes de dormir (min)<input {...num("windDownMin", { min: 0, max: 180 })} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Gimnasio</legend>
          <div className="row2">
            <label>Sesiones mínimas<input {...num("gymSessionsMin", { min: 0, max: 7 })} /></label>
            <label>Sesiones máximas<input {...num("gymSessionsMax", { min: 0, max: 7 })} /></label>
            <label>Bloque mínimo (min)<input {...num("gymBlockMinMin", { min: 30, max: 300 })} /></label>
            <label>Bloque máximo (min)<input {...num("gymBlockMaxMin", { min: 30, max: 300 })} /></label>
            <label>Trayecto cada vía (min)<input {...num("gymTravelMin", { min: 0, max: 60 })} /></label>
            <label>Tras el gimnasio (min)<input {...num("gymAfterMin", { min: 0, max: 120 })} /></label>
          </div>
          <label className="row">
            <input type="checkbox" {...check("gymPreferMorning")} />
            Prefiero ir por la mañana
          </label>
        </fieldset>

        <fieldset>
          <legend>Trayectos, bici y tiempo</legend>
          <div className="row2">
            <label>Trayecto estimado (min)<input {...num("defaultCommuteMin", { min: 0, max: 180 })} /></label>
            <label>Llegar antes (min)<input {...num("arrivalMarginMin", { min: 0, max: 60 })} /></label>
            <label>Bici desde el mes<input {...num("bikeFromMonth", { min: 1, max: 12 })} /></label>
            <label>Bici hasta el mes<input {...num("bikeToMonth", { min: 1, max: 12 })} /></label>
            <label>Bici como mucho (min)<input {...num("bikeMaxMin", { min: 5, max: 90 })} /></label>
            <label>Ciudad<input {...field("cityName")} /></label>
            <label>Latitud<input {...num("latitude", { min: -90, max: 90, step: 0.0001 })} /></label>
            <label>Longitud<input {...num("longitude", { min: -180, max: 180, step: 0.0001 })} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Resúmenes</legend>
          <label className="row">
            <input type="checkbox" {...check("morningBriefing")} />
            Resumen de buenos días
          </label>
          <label className="row">
            <input type="checkbox" {...check("eveningReview")} />
            Repaso corto por la noche
          </label>
        </fieldset>

        <fieldset>
          <legend>Acciones</legend>
          <div className="actions-row">
            <button type="button" className="btn ghost small" disabled={busy !== null} onClick={() => action("uni", onSyncUniversity)}>
              {busy === "uni" ? "Sincronizando…" : "Sincronizar la uni ahora"}
            </button>
            <button type="button" className="btn ghost small" disabled={busy !== null} onClick={() => action("gym", onReplanGym)}>
              {busy === "gym" ? "Planificando…" : "Replanificar gimnasio"}
            </button>
          </div>
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
