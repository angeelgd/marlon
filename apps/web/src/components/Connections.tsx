import { CalendarDays, Check, ChevronDown, Copy, CirclePlay, Map as MapIcon, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Connections as C } from "../lib/api";
import { Group } from "./SettingsParts";

type Msg = { text: string; err?: boolean } | null;

/** Google Calendar, YouTube y Google Maps, configurables desde la app (las claves se guardan cifradas). */
export function Connections() {
  const [data, setData] = useState<C | null>(null);
  const load = useCallback(() => {
    api.connections().then(setData, () => {});
  }, []);
  useEffect(load, [load]);

  return (
    <Group id="s-conexiones" title="Conexiones" foot="Las claves se guardan cifradas en tu base de datos y nunca se vuelven a mostrar.">
      <GoogleCalendar data={data} onChange={load} />
      <ApiKey
        name="youtube"
        icon={CirclePlay}
        title="YouTube"
        purpose="Buscar vídeos de batch cooking."
        source={data?.youtube.source ?? null}
        steps={[
          "En console.cloud.google.com, abre el mismo proyecto de Google.",
          "APIs y servicios > Biblioteca: busca «YouTube Data API v3» y pulsa Habilitar.",
          "APIs y servicios > Credenciales > Crear credenciales > Clave de API.",
          "Edita la clave: en Restricciones de API elige solo YouTube Data API v3. Cópiala y pégala aquí.",
        ]}
        onChange={load}
      />
      <ApiKey
        name="maps"
        icon={MapIcon}
        title="Google Maps"
        purpose="Hora exacta de salida en bus. Sin ella se usa el trayecto estimado."
        source={data?.maps.source ?? null}
        steps={[
          "En el mismo proyecto, Biblioteca: habilita «Routes API» (pide una cuenta de facturación, con crédito gratuito mensual).",
          "Credenciales > Crear credenciales > Clave de API.",
          "Restringe la clave solo a Routes API, cópiala y pégala aquí.",
        ]}
        onChange={load}
      />
    </Group>
  );
}

function Row({ icon: Icon, title, status, ok, action }: { icon: LucideIcon; title: string; status: string; ok: boolean; action?: ReactNode }) {
  return (
    <div className="s-status">
      <span className={`list-lead ${ok ? "ok" : ""}`}>
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <div className="list-main">
        <p>{title}</p>
        <div className="meta">
          {ok && <Check size={12} strokeWidth={2.5} className="ok-tick" />}
          {status}
        </div>
      </div>
      {action}
    </div>
  );
}

function Steps({ items, children }: { items: string[]; children?: ReactNode }) {
  return (
    <details className="steps">
      <summary>
        Cómo conseguirlo <ChevronDown size={14} strokeWidth={2} />
      </summary>
      <ol>
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ol>
      {children}
    </details>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <code>{value}</code>
      <button
        type="button"
        className="icon-btn sm"
        aria-label="Copiar"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={1.75} />}
      </button>
    </div>
  );
}

function GoogleCalendar({ data, onChange }: { data: C | null; onChange(): void }) {
  const g = data?.google;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ text: ok });
      onChange();
      return true;
    } catch (err) {
      setMsg({ text: (err as Error).message, err: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const hasClient = Boolean(g?.clientSource);
  const showClientForm = g !== undefined && (!hasClient || editing) && g.clientSource !== "secret";

  return (
    <div className="s-block">
      <Row
        icon={CalendarDays}
        title="Google Calendar"
        ok={Boolean(g?.connected)}
        status={
          !g ? "Comprobando…" : g.connected ? "Conectado. Se sincroniza cada 5 minutos." : hasClient ? "Listo para conectar." : "Sin conectar. El calendario vive solo en Marlon."
        }
        action={
          g?.connected && g.tokenSource === "app" ? (
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() => window.confirm("¿Desconectar Google Calendar? Los eventos de Google no se borran.") && void run(() => api.deleteConnection("google"), "Google Calendar desconectado.")}
            >
              Desconectar
            </button>
          ) : hasClient && !editing && g?.clientSource === "app" && !g.connected ? (
            <button type="button" className="btn ghost small" onClick={() => setEditing(true)}>
              Cambiar cliente
            </button>
          ) : null
        }
      />

      {g && !g.connected && hasClient && !editing && (
        <div className="actions-row">
          <button type="button" className="btn" onClick={() => (window.location.href = "/api/google/connect")}>
            Conectar con Google
          </button>
        </div>
      )}

      {showClientForm && g && (
        <>
          <Steps
            items={[
              "En console.cloud.google.com crea un proyecto (o usa el de Gemini) y habilita «Google Calendar API» en APIs y servicios > Biblioteca.",
              "Pantalla de consentimiento de OAuth: tipo Externo, añade tu correo como usuario de prueba y luego pulsa Publicar app (si no, el permiso caduca a los 7 días).",
              "Credenciales > Crear credenciales > ID de cliente de OAuth > Aplicación web.",
              "En «URI de redireccionamiento autorizados» añade exactamente esta dirección:",
            ]}
          >
            <CopyField value={g.redirectUri} />
            <p className="muted small">Crea el cliente, copia el ID y el secreto, pégalos abajo y pulsa Conectar con Google. Google avisará de que la app no está verificada: es normal porque es solo tuya, pulsa Configuración avanzada y continúa.</p>
          </Steps>
          <form
            className="s-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.saveConnection("google-client", { clientId, clientSecret })).then((ok) => {
                if (ok) {
                  setEditing(false);
                  setClientId("");
                  setClientSecret("");
                  setMsg({ text: "Cliente guardado. Ahora pulsa Conectar con Google." });
                }
              });
            }}
          >
            <input className="field" placeholder="ID de cliente (….apps.googleusercontent.com)" value={clientId} onChange={(e) => setClientId(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <input className="field" placeholder="Secreto del cliente (GOCSPX-…)" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} type="password" />
            <div className="actions-row">
              <button className="btn" disabled={busy || !clientId.trim() || !clientSecret.trim()}>
                {busy ? "Guardando…" : "Guardar cliente"}
              </button>
              {editing && (
                <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                  Cancelar
                </button>
              )}
            </div>
          </form>
        </>
      )}
      {msg && <p className={`s-msg ${msg.err ? "err" : ""}`}>{msg.text}</p>}
    </div>
  );
}

function ApiKey(props: {
  name: "youtube" | "maps";
  icon: LucideIcon;
  title: string;
  purpose: string;
  source: C["youtube"]["source"];
  steps: string[];
  onChange(): void;
}) {
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const configured = props.source !== null;
  const showForm = (!configured || editing) && props.source !== "secret";

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api.saveConnection(props.name, { key });
      setKey("");
      setEditing(false);
      setMsg({ text: "Clave guardada." });
      props.onChange();
    } catch (err) {
      setMsg({ text: (err as Error).message, err: true });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`¿Quitar la clave de ${props.title}?`)) return;
    await api.deleteConnection(props.name).catch((err: Error) => setMsg({ text: err.message, err: true }));
    setEditing(false);
    props.onChange();
  }

  return (
    <div className="s-block">
      <Row
        icon={props.icon}
        title={props.title}
        ok={configured}
        status={configured ? `Activado${props.source === "secret" ? " (secreto de Cloudflare)" : ""}. ${props.purpose}` : props.purpose}
        action={
          configured && props.source === "app" && !editing ? (
            <button type="button" className="btn ghost small" onClick={() => setEditing(true)}>
              Cambiar
            </button>
          ) : null
        }
      />
      {showForm && (
        <>
          <Steps items={props.steps} />
          <form
            className="s-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input className="field" placeholder="Clave de API (AIza…)" value={key} onChange={(e) => setKey(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button className="btn" disabled={busy || key.trim().length < 10}>
              {busy ? "Comprobando…" : "Guardar"}
            </button>
          </form>
          {editing && (
            <div className="actions-row">
              <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>
                Cancelar
              </button>
              <button type="button" className="btn danger small" onClick={remove}>
                Quitar clave
              </button>
            </div>
          )}
        </>
      )}
      {msg && <p className={`s-msg ${msg.err ? "err" : ""}`}>{msg.text}</p>}
    </div>
  );
}
