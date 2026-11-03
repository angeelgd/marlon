import type {
  AuthStatus,
  CalendarEvent,
  ChangeLogEntry,
  ChatImage,
  ChatRequest,
  Pending,
  SchedulePreview,
  Settings as S,
  UiMessage,
  WellbeingSession,
} from "@marlon/shared";
import { addDays, DEFAULT_SETTINGS, toLocalIso } from "@marlon/shared";
import {
  CalendarDays,
  History as History_,
  LayoutGrid,
  Leaf,
  ListChecks,
  MessageCircle,
  Settings2,
  UtensilsCrossed,
  Volume2,
  VolumeX,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Chat } from "./components/Chat";
import { History } from "./components/History";
import { Pendings } from "./components/Pendings";
import { Food } from "./components/Food";
import { Money } from "./components/Money";
import { More, type MoreSection } from "./components/More";
import { SessionPlayer } from "./components/SessionPlayer";
import { Wellbeing } from "./components/Wellbeing";
import { unlockAudio } from "./lib/sound";
import { Login } from "./components/Login";
import { Settings } from "./components/Settings";
import { WeekCalendar } from "./components/WeekCalendar";
import { api, ApiError, setUnauthorizedHandler } from "./lib/api";
import { disablePush, enablePush, pushState, type PushState } from "./lib/push";
import { speak, stopSpeaking } from "./lib/speech";
import { mondayOf, weekRange } from "./lib/week";

type Tab = "chat" | "week" | "pendings" | "more";
const TABS: Tab[] = ["chat", "week", "pendings", "more"];

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

/** Quita ?tab= y ?say= de la URL sin recargar. */
function clearUrlParams() {
  window.history.replaceState(null, "", location.pathname);
}

function Main({ onLogout }: { onLogout(): void }) {
  const wide = useIsWide();
  const [tab, setTab] = useState<Tab>("chat");
  const [moreSection, setMoreSection] = useState<MoreSection>("money");
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

  const [pendings, setPendings] = useState<Pending[]>([]);
  const [closing, setClosing] = useState<string | null>(null);
  const [push, setPush] = useState<PushState>("off");
  const [session, setSession] = useState<WellbeingSession | null>(null);

  const [history, setHistory] = useState<ChangeLogEntry[]>([]);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const eventsRef = useRef(events);
  eventsRef.current = events;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

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

  const loadPendings = useCallback(async () => {
    try {
      setPendings((await api.pendings()).pendings);
    } catch {
      /* se reintenta al volver a abrir */
    }
  }, []);

  const loadSession = useCallback(() => {
    api.session().then((r) => setSession(r.session), () => {});
  }, []);

  // iOS solo deja sonar audio tras un gesto: se desbloquea con el primer toque.
  useEffect(() => {
    const fn = () => unlockAudio();
    document.addEventListener("pointerdown", fn, { once: true });
    return () => document.removeEventListener("pointerdown", fn);
  }, []);

  // Carga inicial.
  useEffect(() => {
    void loadPendings();
    loadSession();
    void pushState().then(setPush);
    // Al tocar una notificación se abre con ?tab=... o ?say=... (por ejemplo "buenos días").
    const params = new URLSearchParams(location.search);
    const wantTab = params.get("tab");
    if (wantTab && (TABS as string[]).includes(wantTab)) setTab(wantTab as Tab);
    const say = params.get("say");
    // Vuelta del permiso de Google Calendar.
    const connected = params.get("connected");
    const connectError = params.get("connect_error");
    if (connected === "google") {
      const moved = Number(params.get("moved") ?? 0);
      showToast(moved > 0 ? `Google Calendar conectado. ${moved} eventos subidos a Google.` : "Google Calendar conectado.");
    }
    if (connectError) {
      setShowSettings(true);
      showToast(connectError);
    }
    if (wantTab || say || connected || connectError) clearUrlParams();
    if (say) void talk({ text: say.slice(0, 200), images: [] }, say);
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
      if (document.visibilityState === "visible") {
        api.sync().then(() => loadEvents({ markChanges: true }), () => {});
        loadSession();
      }
    };
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  }, [loadEvents, loadSession]);

  const weekVisible = wide ? tab === "chat" || tab === "week" : tab === "week";

  useEffect(() => {
    if (weekVisible) setUnseenChanges(0);
    if (tab === "more" && moreSection === "history") void loadHistory();
    if (tab === "pendings") void loadPendings();
  }, [weekVisible, tab, moreSection, loadHistory, loadPendings]);

  const textOnly = settings.textOnly;

  async function talk(req: ChatRequest, shownText: string, fromVoice = false) {
    const optimisticId = `tmp-${Date.now()}`;
    const optimistic: UiMessage = {
      id: optimisticId,
      role: "user",
      text: shownText,
      createdAt: new Date().toISOString(),
      hasImages: req.images.length > 0 || undefined,
      fromVoice: fromVoice || undefined,
    };
    setMessages((m) => [...m, optimistic]);
    setSending(true);
    try {
      const res = await api.chat(req);
      setMessages((m) => [
        ...m.map((x) => (x.id === optimisticId && res.transcript !== undefined ? { ...x, text: res.transcript || "(sin voz)" } : x)),
        res.message,
      ]);
      // Pulsar, hablar, soltar... y responde con voz. En modo solo texto, nunca.
      if (fromVoice && !settingsRef.current.textOnly) {
        void speak(res.message.text, res.message.lang ?? "es", settingsRef.current.voice);
      }
      void loadPendings();
      if (res.session) setSession(res.session);
      if (res.session === undefined && /para el temporizador|stop/i.test(req.text)) loadSession();
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

  const send = (text: string, images: ChatImage[]) => talk({ text, images }, text);
  const sendVoice = (wavBase64: string) => talk({ text: "", images: [], audio: { mime: "audio/wav", data: wavBase64 } }, "…", true);

  async function toggleTextOnly() {
    const next = !textOnly;
    if (next) stopSpeaking();
    setSettings((s) => ({ ...s, textOnly: next }));
    try {
      setSettings((await api.saveSettings({ textOnly: next })).settings);
    } catch (err) {
      setSettings((s) => ({ ...s, textOnly: !next }));
      showToast((err as Error).message);
    }
    showToast(next ? "Modo solo texto: sin voz ni sonido" : "Voz activada");
  }

  async function closePendingItem(id: string) {
    setClosing(id);
    try {
      await api.closePending(id);
      await loadPendings();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setClosing(null);
    }
  }

  async function deletePendingItem(id: string) {
    const p = pendings.find((x) => x.id === id);
    if (p && !window.confirm(`¿Borrar "${p.title}"?`)) return;
    await api.deletePending(id).catch((err: Error) => showToast(err.message));
    await loadPendings();
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

  const today = toLocalIso(Date.now(), tz).slice(0, 10);
  const todayCount = pendings.filter((p) => (p.kind === "reminder" || p.kind === "task") && p.dueDate !== null && p.dueDate <= today).length;
  const chat = <Chat messages={messages} sending={sending} textOnly={textOnly} onSend={send} onVoice={sendVoice} />;
  const saveSettingsPatch = async (patch: Partial<S>) => {
    const r = await api.saveSettings(patch);
    setSettings(r.settings);
  };
  const more = (
    <More
      section={moreSection}
      hideNav={wide}
      onSection={(sec) => {
        setMoreSection(sec);
        if (sec === "history") void loadHistory();
      }}
      money={tab === "more" && moreSection === "money" ? <Money today={today} onSaveSettings={saveSettingsPatch} onToast={showToast} /> : null}
      wellbeing={
        tab === "more" && moreSection === "wellbeing" ? (
          <Wellbeing
            onToast={showToast}
            onStart={(kind, opt) => {
              api.startSession(kind, opt).then((r) => setSession(r.session), (err: Error) => showToast(err.message));
            }}
            onAsk={(t) => {
              if (!wide) setTab("chat");
              void send(t, []);
            }}
          />
        ) : null
      }
      food={
        tab === "more" && moreSection === "food" ? (
          <Food
            onToast={showToast}
            onAsk={(t) => {
              if (!wide) setTab("chat");
              void send(t, []);
            }}
          />
        ) : null
      }
      history={<History entries={history} busy={undoing} onUndo={undo} />}
    />
  );
  const pendingList = (
    <Pendings pendings={pendings} today={today} busy={closing} onClose={closePendingItem} onDelete={deletePendingItem} />
  );

  const todayLong = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(new Date());
  const voiceBtn = (
    <button
      className={`icon-btn ${textOnly ? "" : "on"}`}
      onClick={toggleTextOnly}
      aria-pressed={!textOnly}
      aria-label={textOnly ? "Activar la voz" : "Pasar a solo texto"}
      title={textOnly ? "Solo texto: sin voz ni sonido" : "Voz activada"}
    >
      {textOnly ? <VolumeX size={20} strokeWidth={1.75} /> : <Volume2 size={20} strokeWidth={1.75} />}
    </button>
  );
  const settingsBtn = (
    <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Ajustes">
      <Settings2 size={20} strokeWidth={1.75} />
    </button>
  );

  const deskView: "week" | "pendings" | MoreSection = tab === "pendings" ? "pendings" : tab === "more" ? moreSection : "week";
  const goDesk = (v: "week" | "pendings" | MoreSection) => {
    if (v === "week") setTab("week");
    else if (v === "pendings") setTab("pendings");
    else {
      setMoreSection(v);
      setTab("more");
      if (v === "history") void loadHistory();
    }
  };
  const NAV: { key: "week" | "pendings" | MoreSection; label: string; icon: typeof CalendarDays; badge?: number }[] = [
    { key: "week", label: "Semana", icon: CalendarDays, badge: unseenChanges },
    { key: "pendings", label: "Pendientes", icon: ListChecks, badge: todayCount },
    { key: "money", label: "Dinero", icon: Wallet },
    { key: "food", label: "Comida", icon: UtensilsCrossed },
    { key: "wellbeing", label: "Bienestar", icon: Leaf },
    { key: "history", label: "Historial", icon: History_ },
  ];
  const TITLES: Record<Tab, string> = { chat: "Marlon", week: "Semana", pendings: "Pendientes", more: "Más" };
  const MOBILE_TABS: { key: Tab; label: string; icon: typeof CalendarDays; badge?: number }[] = [
    { key: "chat", label: "Chat", icon: MessageCircle },
    { key: "week", label: "Semana", icon: CalendarDays, badge: unseenChanges },
    { key: "pendings", label: "Pendientes", icon: ListChecks, badge: todayCount },
    { key: "more", label: "Más", icon: LayoutGrid },
  ];

  return (
    <div className={`app ${wide ? "wide" : "narrow"}`}>
      {wide ? (
        <>
          <aside className="sidebar">
            <div className="brand">
              <span className="brand-mark" aria-hidden>M</span>
              <span className="brand-name">Marlon</span>
            </div>
            <nav className="nav" aria-label="Secciones">
              {NAV.map(({ key, label, icon: Icon, badge }) => (
                <button key={key} aria-current={deskView === key ? "page" : undefined} onClick={() => goDesk(key)}>
                  <Icon size={18} strokeWidth={1.75} />
                  {label}
                  {badge ? <span className="pill">{badge}</span> : null}
                </button>
              ))}
            </nav>
            <div className="sidebar-foot nav">
              <button onClick={toggleTextOnly} aria-pressed={!textOnly}>
                {textOnly ? <VolumeX size={18} strokeWidth={1.75} /> : <Volume2 size={18} strokeWidth={1.75} />}
                {textOnly ? "Solo texto" : "Voz activada"}
              </button>
              <button onClick={() => setShowSettings(true)}>
                <Settings2 size={18} strokeWidth={1.75} />
                Ajustes
              </button>
              <div className="sidebar-status">
                <span className={`badge ${backend === "google" ? "ok" : "warn"}`}>
                  {backend === "google" ? "Google Calendar" : "Calendario local"}
                </span>
              </div>
            </div>
          </aside>
          <section className="chat-col" aria-label="Conversación">
            <header className="chat-col-head">
              <span className="eyebrow">Hoy</span>
              <h2>{todayLong}</h2>
            </header>
            {chat}
          </section>
          <main className="main-col">
            {deskView === "week" ? calendar : deskView === "pendings" ? pendingList : more}
          </main>
        </>
      ) : (
        <>
          <header className="appbar">
            <div className="appbar-title">
              {tab === "chat" && <span className="eyebrow">{todayLong}</span>}
              <h1>{TITLES[tab]}</h1>
            </div>
            <div className="appbar-actions">
              {voiceBtn}
              {settingsBtn}
            </div>
          </header>
          <main className="panes" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <div className="pane" hidden={tab !== "chat"}>{chat}</div>
            <div className="pane" hidden={tab !== "week"}>{calendar}</div>
            <div className="pane" hidden={tab !== "pendings"}>{pendingList}</div>
            <div className="pane" hidden={tab !== "more"}>{more}</div>
          </main>
          <nav className="tabbar" role="tablist" aria-label="Secciones">
            {MOBILE_TABS.map(({ key, label, icon: Icon, badge }) => (
              <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
                <Icon size={23} strokeWidth={tab === key ? 2 : 1.6} />
                {label}
                {badge ? <span className="pill">{badge}</span> : null}
              </button>
            ))}
          </nav>
        </>
      )}

      {!wide && unseenChanges > 0 && tab === "chat" && (
        <button className="toast action" onClick={() => setTab("week")}>
          {unseenChanges} {unseenChanges === 1 ? "cambio" : "cambios"} en tu semana · Ver
        </button>
      )}
      {toast && <div className="toast">{toast}</div>}

      {session && (
        <SessionPlayer
          key={`${session.id}:${session.startedAt}:${session.status}`}
          session={session}
          textOnly={textOnly}
          voice={settings.voice}
          onPause={() => api.sessionAction(session.id, "pause").then((r) => r.session && setSession(r.session), (e: Error) => showToast(e.message))}
          onResume={() => api.sessionAction(session.id, "resume").then((r) => r.session && setSession(r.session), (e: Error) => showToast(e.message))}
          onStop={() => api.sessionAction(session.id, "cancel").finally(() => setSession(null))}
          onDone={() => setSession(null)}
        />
      )}

      {showSettings && (
        <Settings
          settings={settings}
          calendarBackend={backend}
          onClose={() => setShowSettings(false)}
          onLogout={onLogout}
          onSave={saveSettingsPatch}
          onCalendarChanged={() => void Promise.all([loadEvents({ markChanges: true }), loadHistory()])}
          onSyncUniversity={async () => {
            const r = await api.syncUniversity();
            await Promise.all([loadEvents({ markChanges: true }), loadHistory()]);
            const solapes = r.conflicts.length ? ` Ojo: ${r.conflicts.length} solapes con el trabajo.` : "";
            return `Uni: ${r.created} nuevas, ${r.changed} cambiadas, ${r.removed} quitadas.${solapes}`;
          }}
          push={push}
          onEnablePush={async () => {
            const st = await enablePush();
            setPush(st);
            return st === "on" ? "Notificaciones activadas." : st === "denied" ? "Permiso denegado: actívalo en los ajustes del iPhone." : "No se activaron.";
          }}
          onDisablePush={async () => {
            setPush(await disablePush());
            return "Notificaciones desactivadas en este dispositivo.";
          }}
          onTestPush={async () => {
            const r = await api.pushTest();
            return r.sent ? "Enviada. Debería llegarte en unos segundos." : "No se pudo enviar (¿están activadas?).";
          }}
          onReplanGym={async () => {
            const r = await api.replanGym();
            await Promise.all([loadEvents({ markChanges: true }), loadHistory()]);
            return r.sessions.length
              ? `Gimnasio: ${r.sessions.length} sesiones esta semana (${r.created + r.changed + r.removed} cambios).`
              : "Esta semana no cabe el gimnasio sin recortar sueño.";
          }}
        />
      )}
    </div>
  );
}
