import type { AuthStatus, CalendarEvent, ChangeLogEntry, ChatImage, SchedulePreview, Settings as S, UiMessage } from "@marlon/shared";
import { addDays, DEFAULT_SETTINGS } from "@marlon/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Chat } from "./components/Chat";
import { History } from "./components/History";
import { Login } from "./components/Login";
import { Settings } from "./components/Settings";
import { WeekCalendar } from "./components/WeekCalendar";
import { api, ApiError, setUnauthorizedHandler } from "./lib/api";
import { mondayOf, weekRange } from "./lib/week";

type Tab = "chat" | "week" | "history";
const TABS: Tab[] = ["chat", "week", "history"];

function useIsWide() {
  const q = "(min-width: 900px)";
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const fn = () => setWide(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);
  return wide;
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  const refreshAuth = useCallback(() => {
    api.authStatus().then(setAuth, () => setAuth({ authenticated: false, hasCredentials: true }));
  }, []);

  useEffect(() => {
    refreshAuth();
    setUnauthorizedHandler(() => setAuth((a) => ({ authenticated: false, hasCredentials: a?.hasCredentials ?? true })));
  }, [refreshAuth]);

  if (!auth) return <div className="splash" />;
  if (!auth.authenticated) return <Login hasCredentials={auth.hasCredentials} onDone={refreshAuth} />;
  return <Main onLogout={() => api.logout().finally(refreshAuth)} />;
}

function Main({ onLogout }: { onLogout(): void }) {
  const wide = useIsWide();
  const [tab, setTab] = useState<Tab>("chat");
  const [settings, setSettings] = useState<S>(DEFAULT_SETTINGS);
  const [backend, setBackend] = useState<"google" | "local">("local");
  const [showSettings, setShowSettings] = useState(false);
  const tz = settings.timezone;

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [sending, setSending] = useState(false);

  const [monday, setMonday] = useState(() => mondayOf(Date.now(), DEFAULT_SETTINGS.timezone));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [unseenChanges, setUnseenChanges] = useState(0);

  const [history, setHistory] = useState<ChangeLogEntry[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const eventsRef = useRef(events);
  eventsRef.current = events;

  const showToast = useCallback((t: string) => {
    setToast(t);
    setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 3500);
  }, []);

  const loadEvents = useCallback(
    async (opts: { markChanges?: boolean } = {}) => {
      setLoadingEvents(true);
      try {
        const { from, to } = weekRange(monday, tz);
        const res = await api.events(from, to);
        if (opts.markChanges) {
          const before = new Map(eventsRef.current.map((e) => [e.id, `${e.start}|${e.end}`]));
          const changed = res.events.filter((e) => before.get(e.id) !== `${e.start}|${e.end}`).map((e) => e.id);
          if (changed.length) {
            setHighlight(new Set(changed));
            setTimeout(() => setHighlight(new Set()), 2500);
          }
        }
        setEvents(res.events);
        setBackend(res.backend);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) showToast((err as Error).message);
      } finally {
        setLoadingEvents(false);
      }
    },
    [monday, tz, showToast],
  );

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await api.history()).entries);
    } catch {
      /* se reintenta al volver a abrir */
    }
  }, []);

  // Carga inicial.
  useEffect(() => {
    api.settings().then((r) => {
      setSettings(r.settings);
      setBackend(r.calendarBackend);
      setMonday(mondayOf(Date.now(), r.settings.timezone));
    }, () => {});
    api.messages().then((r) => setMessages(r.messages), () => {});
    void loadHistory();
    // Al abrir la app se traen los cambios hechos a mano en Google Calendar.
    api.sync().then(() => loadEvents(), () => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  // Al volver a la app (iOS la congela en segundo plano), refresco.
  useEffect(() => {
    const fn = () => {
      if (document.visibilityState === "visible") api.sync().then(() => loadEvents({ markChanges: true }), () => {});
    };
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  }, [loadEvents]);

  const weekVisible = wide || tab === "week";

  useEffect(() => {
    if (weekVisible) setUnseenChanges(0);
    if (tab === "history") void loadHistory();
  }, [weekVisible, tab, loadHistory]);

  async function send(text: string, images: ChatImage[]) {
    const optimistic: UiMessage = {
      id: `tmp-${Date.now()}`,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
      hasImages: images.length > 0 || undefined,
    };
    setMessages((m) => [...m, optimistic]);
    setSending(true);
    try {
      const res = await api.chat({ text, images });
      setMessages((m) => [...m, res.message]);
      if (res.notice) showToast(res.notice);
      if (res.preview) {
        setPreview(res.preview);
        const first = res.preview.shifts[0]?.date;
        if (first) setMonday(mondayOf(Date.parse(`${first}T12:00:00Z`), tz));
      }
      if (res.changeIds.length || res.preview) {
        await loadEvents({ markChanges: true });
        void loadHistory();
        if (!weekVisible && res.changeIds.length) setUnseenChanges((n) => n + res.changeIds.length);
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        { id: `err-${Date.now()}`, role: "assistant", text: `No me ha llegado bien: ${(err as Error).message}`, createdAt: new Date().toISOString() },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function undo(id: string) {
    setUndoing(id);
    try {
      const r = await api.undo(id);
      showToast(r.undone > 1 ? `Deshechos ${r.undone} cambios` : "Cambio deshecho");
      await Promise.all([loadEvents({ markChanges: true }), loadHistory()]);
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setUndoing(null);
    }
  }

  async function confirmPreview() {
    if (!preview) return;
    try {
      await api.confirmSchedule(preview.uploadId);
      setPreview({ ...preview, status: "confirmed" });
      showToast("Horario guardado");
      await Promise.all([loadEvents({ markChanges: true }), loadHistory()]);
    } catch (err) {
      showToast((err as Error).message);
    }
  }

  async function discardPreview() {
    if (!preview) return;
    await api.discardSchedule(preview.uploadId).catch(() => {});
    setPreview(null);
  }

  // Cambio rápido de pestaña deslizando en horizontal (móvil).
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]!;
    touch.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (wide || !touch.current) return;
    const t = e.changedTouches[0]!;
    const dx = t.clientX - touch.current.x;
    const dy = t.clientY - touch.current.y;
    touch.current = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const i = TABS.indexOf(tab);
    const next = TABS[Math.min(TABS.length - 1, Math.max(0, i + (dx < 0 ? 1 : -1)))]!;
    setTab(next);
  };

  const calendar = (
    <WeekCalendar
      tz={tz}
      monday={monday}
      events={events}
      preview={preview}
      highlight={highlight}
      visible={weekVisible}
      loading={loadingEvents}
      onPrev={() => setMonday((m) => addDays(m, -7))}
      onNext={() => setMonday((m) => addDays(m, 7))}
      onToday={() => setMonday(mondayOf(Date.now(), tz))}
      onConfirmPreview={confirmPreview}
      onDiscardPreview={discardPreview}
    />
  );

  return (
    <div className={`app ${wide ? "wide" : "narrow"}`}>
      <header className="topbar">
        <h1>Marlon</h1>
        {!wide && (
          <nav className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Chat</button>
            <button role="tab" aria-selected={tab === "week"} onClick={() => setTab("week")}>
              Semana{unseenChanges > 0 && <span className="pill">{unseenChanges}</span>}
            </button>
            <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>Historial</button>
          </nav>
        )}
        <div className="topbar-actions">
          {wide && (
            <button className="icon-btn" onClick={() => setTab(tab === "history" ? "chat" : "history")} aria-label="Historial">
              ↺
            </button>
          )}
          {backend === "local" && wide && <span className="badge local small" title="Sin Google Calendar">local</span>}
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Ajustes">⚙</button>
        </div>
      </header>

      <main className="panes" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {wide ? (
          <>
            <div className="pane pane-chat">
              <Chat messages={messages} sending={sending} onSend={send} />
            </div>
            <div className="pane pane-week">{calendar}</div>
            {tab === "history" && (
              <aside className="pane pane-history">
                <History entries={history} busy={undoing} onUndo={undo} />
              </aside>
            )}
          </>
        ) : (
          <>
            <div className="pane" hidden={tab !== "chat"}>
              <Chat messages={messages} sending={sending} onSend={send} />
            </div>
            <div className="pane" hidden={tab !== "week"}>{calendar}</div>
            <div className="pane" hidden={tab !== "history"}>
              <History entries={history} busy={undoing} onUndo={undo} />
            </div>
          </>
        )}
      </main>

      {!wide && unseenChanges > 0 && tab === "chat" && (
        <button className="toast action" onClick={() => setTab("week")}>
          {unseenChanges} {unseenChanges === 1 ? "cambio" : "cambios"} en tu semana · Ver
        </button>
      )}
      {toast && <div className="toast">{toast}</div>}

      {showSettings && (
        <Settings
          settings={settings}
          calendarBackend={backend}
          onClose={() => setShowSettings(false)}
          onLogout={onLogout}
          onSave={async (patch) => {
            const r = await api.saveSettings(patch);
            setSettings(r.settings);
          }}
        />
      )}
    </div>
  );
}
