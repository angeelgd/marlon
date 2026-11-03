import type { Settings as S } from "@marlon/shared";
import {
  Bell,
  Bike,
  BookOpen,
  Brain,
  Briefcase,
  CalendarDays,
  Dumbbell,
  GraduationCap,
  Link2,
  MapPin,
  Moon,
  Plug,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type UniversityLink } from "../lib/api";
import type { PushState } from "../lib/push";
import { Connections } from "./Connections";
import { MemoryEditor } from "./MemoryEditor";
import { Group, Label } from "./SettingsParts";

interface Props {
  settings: S;
  calendarBackend: "google" | "local";
  onSave(patch: Partial<S>): Promise<void>;
  onClose(): void;
  onLogout(): void;
  /** Acciones rápidas; devuelven un texto para mostrar. */
  onSyncUniversity(): Promise<string>;
  onReplanGym(): Promise<string>;
  /** Tras guardar el enlace de la uni se recarga el calendario. */
  onCalendarChanged(): void;
  push: PushState;
  onEnablePush(): Promise<string>;
  onDisablePush(): Promise<string>;
  onTestPush(): Promise<string>;
}

const PUSH_TEXT: Record<PushState, string> = {
  on: "Activadas en este dispositivo.",
  off: "Desactivadas en este dispositivo.",
  denied: "Bloqueadas. Actívalas en Ajustes del iPhone > Notificaciones > Marlon.",
  "needs-install": "En el iPhone solo funcionan con Marlon instalado: Safari > Compartir > Añadir a pantalla de inicio.",
  unsupported: "Este navegador no admite notificaciones push.",
};

const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "s-conexiones", label: "Conexiones", icon: Plug },
  { id: "s-avisos", label: "Avisos y voz", icon: Bell },
  { id: "s-trabajo", label: "Trabajo", icon: Briefcase },
  { id: "s-uni", label: "Universidad", icon: GraduationCap },
  { id: "s-calendario", label: "Calendario", icon: CalendarDays },
  { id: "s-lugares", label: "Lugares", icon: MapPin },
  { id: "s-sueno", label: "Sueño y rutina", icon: Moon },
  { id: "s-gym", label: "Gimnasio", icon: Dumbbell },
  { id: "s-trayectos", label: "Trayectos y tiempo", icon: Bike },
  { id: "s-resumenes", label: "Resúmenes", icon: Sparkles },
  { id: "s-estudio", label: "Estudio y lectura", icon: BookOpen },
  { id: "s-memoria", label: "Memoria", icon: Brain },
  { id: "s-acciones", label: "Mantenimiento", icon: Wrench },
];

export function Settings(props: Props) {
  const { settings, calendarBackend, onSave, onClose, onLogout, push } = props;
  const [draft, setDraft] = useState<S>(settings);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [active, setActive] = useState(SECTIONS[0]!.id);
  const scrollRef = useRef<HTMLDivElement>(null);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(settings), [draft, settings]);

  // Resalta en la barra lateral la sección visible.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.id);
      },
      { root, rootMargin: "0px 0px -70% 0px" },
    );
    root.querySelectorAll(".s-group[id]").forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  const text = <K extends keyof S>(key: K) => ({
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
  const toggle = <K extends keyof S>({ k, title, hint }: { k: K; title: string; hint?: string }) => (
    <label className="s-row">
      <Label title={title} hint={hint} />
      <span className="switch">
        <input type="checkbox" checked={draft[k] as boolean} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
        <span />
      </span>
    </label>
  );
  const numRow = <K extends keyof S>({ k, title, unit, hint, ...o }: { k: K; title: string; unit?: string; hint?: string; min?: number; max?: number; step?: number }) => (
    <label className="s-row">
      <Label title={title} hint={hint} />
      <input {...num(k, o)} />
      {unit && <span className="unit">{unit}</span>}
    </label>
  );
  const textRow = <K extends keyof S>({ k, title, placeholder, hint }: { k: K; title: string; placeholder?: string; hint?: string }) => (
    <label className="s-row">
      <Label title={title} hint={hint} />
      <input {...text(k)} placeholder={placeholder ?? "Añadir"} autoComplete="off" />
    </label>
  );
  const timeRow = <K extends keyof S>({ k, title }: { k: K; title: string }) => (
    <label className="s-row">
      <Label title={title} />
      <input type="time" {...text(k)} required />
    </label>
  );

  const action = async (name: string, fn: () => Promise<string>) => {
    setBusy(name);
    setMsg(null);
    try {
      setMsg({ text: await fn() });
    } catch (err) {
      setMsg({ text: (err as Error).message, err: true });
    } finally {
      setBusy(null);
    }
  };

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      await onSave(draft);
      setMsg({ text: "Cambios guardados." });
    } catch (err) {
      setMsg({ text: (err as Error).message, err: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Ajustes">
        <header className="sheet-head">
          <button type="button" className="text-btn" onClick={onClose}>
            {dirty ? "Cancelar" : "Cerrar"}
          </button>
          <h2>Ajustes</h2>
          <button type="button" className="text-btn strong" onClick={save} disabled={!dirty || saving}>
            {saving ? "Guardando…" : "Guardar"}
          </button>
        </header>

        <div className="sheet-body">
          <nav className="settings-nav nav" aria-label="Secciones de ajustes">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                aria-current={active === id ? "page" : undefined}
                onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                <Icon size={17} strokeWidth={1.75} />
                {label}
              </button>
            ))}
          </nav>

          <div className="settings-scroll" ref={scrollRef}>
            <div className="settings-content">
              {msg && <p className={`s-msg ${msg.err ? "err" : ""}`} role="status">{msg.text}</p>}

              <Connections />

              <Group id="s-avisos" title="Avisos y voz" foot={`Notificaciones: ${PUSH_TEXT[push]}`}>
                {toggle({ k: "textOnly", title: "Solo texto", hint: "Sin voz ni sonido, también en los avisos." })}
                <label className="s-row">
                  <Label title="Voz de las respuestas" />
                  <select value={draft.voice} onChange={(e) => setDraft({ ...draft, voice: e.target.value as S["voice"] })}>
                    <option value="browser">La del iPhone</option>
                    <option value="provider">La del proveedor</option>
                  </select>
                </label>
                {toggle({ k: "pendingNudges", title: "Insistir con los pendientes", hint: "Te los recuerda a lo largo del día." })}
                {numRow({ k: "leaveReminderMin", title: "Aviso para salir", unit: "min", hint: "Antes de cada trayecto. 0 lo desactiva.", min: 0, max: 60 })}
                {numRow({ k: "eveningReviewLeadMin", title: "Repaso antes de dormir", unit: "min", min: 0, max: 180 })}
                {numRow({ k: "birthdayNoticeDays", title: "Cumpleaños, avisar con", unit: "días", min: 0, max: 60 })}
                {(push === "off" || push === "on") && (
                <div className="s-block">
                  <div className="actions-row">
                    {push === "off" && (
                      <button type="button" className="btn small" disabled={busy !== null} onClick={() => action("push", props.onEnablePush)}>
                        Activar notificaciones
                      </button>
                    )}
                    {push === "on" && (
                      <>
                        <button type="button" className="btn soft small" disabled={busy !== null} onClick={() => action("test", props.onTestPush)}>
                          Enviar una de prueba
                        </button>
                        <button type="button" className="btn ghost small" disabled={busy !== null} onClick={() => action("push", props.onDisablePush)}>
                          Desactivar en este dispositivo
                        </button>
                      </>
                    )}
                  </div>
                </div>
                )}
              </Group>

              <Group id="s-trabajo" title="Horario de trabajo" foot="La foto del horario incluye los turnos de tus compañeros: por defecto solo se envía con la clave de pago.">
                {textRow({ k: "scheduleColumnName", title: "Tu columna en la foto" })}
                {textRow({ k: "workEventTitle", title: "Título de los turnos" })}
                {toggle({ k: "autoConfirmCleanSchedule", title: "Guardar sin preguntar", hint: "Si la foto no tiene dudas, se guarda y te avisa." })}
                {toggle({ k: "allowFreeTierForSchedulePhoto", title: "Permitir la capa gratuita para la foto" })}
              </Group>

              <UniversityGroup onChanged={props.onCalendarChanged} />

              <Group id="s-calendario" title="Calendario">
                <div className="s-row">
                  <Label title="Conexión" />
                  <span className={`badge ${calendarBackend === "google" ? "ok" : "warn"}`}>
                    {calendarBackend === "google" ? "Google Calendar" : "Local, sin Google"}
                  </span>
                </div>
                {textRow({ k: "googleCalendarId", title: "ID del calendario" })}
                {textRow({ k: "timezone", title: "Zona horaria" })}
                {timeRow({ k: "dayStart", title: "Empieza el día" })}
                {timeRow({ k: "dayEnd", title: "Acaba el día" })}
              </Group>

              <Group id="s-lugares" title="Lugares" foot="Solo se guardan aquí, en tu base de datos. Sirven para calcular trayectos.">
                {textRow({ k: "homeAddress", title: "Casa" })}
                {textRow({ k: "workLocation", title: "Trabajo" })}
                {textRow({ k: "universityAddress", title: "Universidad" })}
                {textRow({ k: "gymAddress", title: "Gimnasio" })}
              </Group>

              <Group id="s-sueno" title="Sueño y rutina">
                {numRow({ k: "sleepHours", title: "Horas de sueño", unit: "h", hint: "Nunca menos de 8.", min: 8, max: 12, step: 0.5 })}
                {timeRow({ k: "freeDayWake", title: "Levantarse en días libres" })}
                {numRow({ k: "morningRoutineMin", title: "Rutina de mañana", unit: "min", min: 0, max: 180 })}
                {numRow({ k: "windDownMin", title: "Desconectar antes de dormir", unit: "min", min: 0, max: 180 })}
              </Group>

              <Group id="s-gym" title="Gimnasio">
                {numRow({ k: "gymSessionsMin", title: "Sesiones mínimas", unit: "/sem", min: 0, max: 7 })}
                {numRow({ k: "gymSessionsMax", title: "Sesiones máximas", unit: "/sem", min: 0, max: 7 })}
                {numRow({ k: "gymBlockMinMin", title: "Duración mínima", unit: "min", min: 30, max: 300 })}
                {numRow({ k: "gymBlockMaxMin", title: "Duración máxima", unit: "min", min: 30, max: 300 })}
                {numRow({ k: "gymTravelMin", title: "Trayecto, cada vía", unit: "min", min: 0, max: 60 })}
                {numRow({ k: "gymAfterMin", title: "Margen después", unit: "min", min: 0, max: 120 })}
                {toggle({ k: "gymPreferMorning", title: "Prefiero ir por la mañana" })}
              </Group>

              <Group id="s-trayectos" title="Trayectos y tiempo">
                {numRow({ k: "defaultCommuteMin", title: "Trayecto estimado", unit: "min", min: 0, max: 180 })}
                {numRow({ k: "arrivalMarginMin", title: "Llegar con antelación", unit: "min", min: 0, max: 60 })}
                {numRow({ k: "bikeFromMonth", title: "Bici desde el mes", min: 1, max: 12 })}
                {numRow({ k: "bikeToMonth", title: "Bici hasta el mes", min: 1, max: 12 })}
                {numRow({ k: "bikeMaxMin", title: "Bici como mucho", unit: "min", min: 5, max: 90 })}
                {textRow({ k: "cityName", title: "Ciudad" })}
                {numRow({ k: "latitude", title: "Latitud", min: -90, max: 90, step: 0.0001 })}
                {numRow({ k: "longitude", title: "Longitud", min: -180, max: 180, step: 0.0001 })}
              </Group>

              <Group id="s-resumenes" title="Resúmenes">
                {toggle({ k: "morningBriefing", title: "Resumen de buenos días" })}
                {toggle({ k: "eveningReview", title: "Repaso corto por la noche" })}
              </Group>

              <Group id="s-estudio" title="Estudio y lectura">
                {numRow({ k: "studyBlockMin", title: "Bloque de estudio", unit: "min", min: 15, max: 180 })}
                {numRow({ k: "studyBreakRatio", title: "Descanso (proporción)", min: 0.1, max: 0.5, step: 0.05 })}
                {toggle({ k: "readingPrompts", title: "Preguntar por el libro", hint: "Al acabar un trayecto en bus." })}
              </Group>

              <Group id="s-memoria" title="Lo que Marlon sabe de ti">
                <div className="s-block memory">
                  <MemoryEditor />
                </div>
              </Group>

              <Group id="s-acciones" title="Mantenimiento">
                <div className="s-block">
                  <div className="actions-row">
                    <button type="button" className="btn soft small" disabled={busy !== null} onClick={() => action("uni", props.onSyncUniversity)}>
                      {busy === "uni" ? "Sincronizando…" : "Sincronizar la universidad"}
                    </button>
                    <button type="button" className="btn soft small" disabled={busy !== null} onClick={() => action("gym", props.onReplanGym)}>
                      {busy === "gym" ? "Planificando…" : "Replanificar el gimnasio"}
                    </button>
                  </div>
                </div>
              </Group>

              <section className="s-group">
                <div className="s-list">
                  <button type="button" className="s-danger" onClick={onLogout}>
                    Cerrar sesión
                  </button>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Enlace iCal de la uni: se guarda cifrado y nunca se vuelve a mostrar entero. */
function UniversityGroup({ onChanged }: { onChanged(): void }) {
  const [link, setLink] = useState<UniversityLink | null>(null);
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  useEffect(() => {
    api.universityLink().then(setLink, () => setLink({ configured: false, source: null, host: null }));
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.saveUniversityLink(url);
      setLink(r);
      setUrl("");
      setEditing(false);
      const s = r.sync;
      setMsg({ text: `Conectado. ${s.created} clases nuevas, ${s.changed} actualizadas${s.conflicts.length ? `, ${s.conflicts.length} solapes con el trabajo` : ""}.` });
      onChanged();
    } catch (err) {
      setMsg({ text: (err as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("¿Quitar el enlace del calendario de la universidad? Las clases ya importadas se quedan.")) return;
    setBusy(true);
    try {
      setLink(await api.deleteUniversityLink());
      setMsg({ text: "Enlace quitado." });
    } catch (err) {
      setMsg({ text: (err as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  }

  const showForm = editing || (link !== null && !link.configured);

  return (
    <Group
      id="s-uni"
      title="Universidad"
      foot="En Lukkari, abre tu horario, pulsa Exportar o iCal y copia el enlace. Se guarda cifrado y se sincroniza cada 3 horas."
    >
      <div className="s-block">
        <div className="s-status">
          <span className="list-lead">
            <Link2 size={16} strokeWidth={1.75} />
          </span>
          <div className="list-main">
            <p>{link === null ? "Comprobando…" : link.configured ? "Calendario conectado" : "Sin conectar"}</p>
            <div className="meta">
              {link?.configured
                ? `${link.host ?? ""}${link.source === "secret" ? " · fijado en Cloudflare" : ""}`
                : "Pega el enlace iCal de tu horario."}
            </div>
          </div>
          {link?.configured && link.source === "app" && !editing && (
            <button type="button" className="btn ghost small" onClick={() => setEditing(true)}>
              Cambiar
            </button>
          )}
        </div>
        {showForm && link?.source !== "secret" && (
          <form
            className="s-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input
              className="field"
              type="url"
              inputMode="url"
              placeholder="https://lukkari…/ical?hash=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="btn" disabled={busy || !url.trim()}>
              {busy ? "Comprobando…" : "Conectar"}
            </button>
          </form>
        )}
        {editing && (
          <div className="actions-row">
            <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>
              Cancelar
            </button>
            <button type="button" className="btn danger small" onClick={remove} disabled={busy}>
              Quitar enlace
            </button>
          </div>
        )}
        {msg && <p className={`s-msg ${msg.err ? "err" : ""}`}>{msg.text}</p>}
      </div>
    </Group>
  );
}
