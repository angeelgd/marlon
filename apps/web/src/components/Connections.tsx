import { CalendarDays, Check, ChevronDown, Copy, CirclePlay, Landmark, Map as MapIcon, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Aspsp, type BankStatus, type Connections as C } from "../lib/api";
import { formatEuros } from "@marlon/shared";
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
      <Bank data={data} onChange={load} />
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

const fmtDay = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)) : "";
const fmtWhen = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "nunca";

const COUNTRIES: [string, string][] = [
  ["FI", "Finlandia"],
  ["ES", "España"],
  ["PT", "Portugal"],
  ["FR", "Francia"],
  ["DE", "Alemania"],
  ["IT", "Italia"],
  ["NL", "Países Bajos"],
  ["SE", "Suecia"],
  ["EE", "Estonia"],
  ["LT", "Lituania"],
];

/** Banca abierta (PSD2) con Enable Banking: solo lectura de saldos y movimientos. */
function Bank({ data, onChange }: { data: C | null; onChange(): void }) {
  const src = data?.bank.source ?? null;
  const [status, setStatus] = useState<BankStatus | null>(null);
  const [banks, setBanks] = useState<Aspsp[] | null>(null);
  const [choice, setChoice] = useState("");
  const [country, setCountry] = useState("FI");
  const [appId, setAppId] = useState("");
  const [pem, setPem] = useState("");
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const loadStatus = useCallback(() => {
    api.bank().then(setStatus, () => {});
  }, []);
  useEffect(() => {
    if (src) loadStatus();
  }, [src, loadStatus]);

  const active = (status?.links ?? []).filter((l) => l.status === "active");
  const expired = (status?.links ?? []).filter((l) => l.status === "expired");
  const showPicker = Boolean(src) && !editing && (adding || (status !== null && active.length === 0));

  useEffect(() => {
    if (!showPicker) return;
    let alive = true;
    setBanks(null);
    setChoice("");
    api.bankAspsps(country).then(
      (r) => alive && setBanks(r.aspsps.sort((a, b) => a.name.localeCompare(b.name))),
      (err: Error) => alive && setMsg({ text: err.message, err: true }),
    );
    return () => {
      alive = false;
    };
  }, [showPicker, country]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ text: ok });
      return true;
    } catch (err) {
      setMsg({ text: (err as Error).message, err: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const total = active.flatMap((l) => l.accounts).reduce((s, a) => s + (a.balanceCents ?? 0), 0);

  return (
    <div className="s-block">
      <Row
        icon={Landmark}
        title="Banco"
        ok={active.length > 0}
        status={
          !data
            ? "Comprobando…"
            : active.length
              ? `${active.map((l) => l.bank).join(", ")} · saldo ${formatEuros(total)}`
              : src
                ? "Listo para conectar tu banco."
                : "Lee tus movimientos y gastos, solo lectura."
        }
        action={
          src === "app" && !editing && active.length === 0 ? (
            <button type="button" className="btn ghost small" onClick={() => setEditing(true)}>
              Cambiar app
            </button>
          ) : null
        }
      />

      {active.map((l) => (
        <div key={l.id} className="bank-link">
          <ul className="bank-accounts">
            {l.accounts.map((a) => (
              <li key={a.uid}>
                <span>
                  {a.name ?? "Cuenta"} <span className="muted small">{a.iban}</span>
                </span>
                <b className="num">{a.balanceCents === null ? "—" : formatEuros(a.balanceCents)}</b>
              </li>
            ))}
          </ul>
          <p className="muted small">
            {l.bank} · actualizado {fmtWhen(l.lastSyncAt)} · permiso hasta {fmtDay(l.validUntil)}
            {l.lastError ? ` · ${l.lastError}` : ""}
          </p>
          <div className="actions-row">
            <button
              type="button"
              className="btn soft small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.bankSync();
                  loadStatus();
                  setMsg({ text: r.errors.length ? r.errors.join(" ") : `${r.newTransactions} movimientos nuevos, ${r.newExpenses} gastos apuntados.`, err: r.errors.length > 0 });
                })
              }
            >
              {busy ? "Actualizando…" : "Actualizar ahora"}
            </button>
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() =>
                window.confirm(`¿Desconectar ${l.bank}? Los gastos ya importados se quedan.`) &&
                void run(async () => {
                  await api.bankDisconnect(l.id);
                  loadStatus();
                }, "Banco desconectado.")
              }
            >
              Desconectar
            </button>
          </div>
        </div>
      ))}

      {expired.length > 0 && <p className="s-msg err">El permiso de {expired.map((l) => l.bank).join(", ")} ha caducado. Vuelve a conectarlo abajo.</p>}

      {active.length > 0 && !adding && (
        <div className="actions-row">
          <button type="button" className="btn ghost small" onClick={() => setAdding(true)}>
            Añadir otro banco
          </button>
        </div>
      )}

      {showPicker && (
        <form
          className="s-input-row"
          onSubmit={(e) => {
            e.preventDefault();
            const a = banks?.find((b) => b.name === choice);
            if (!a) return;
            void run(async () => {
              const { url } = await api.bankConnect(a);
              window.location.href = url;
            });
          }}
        >
          <select className="field country" value={country} onChange={(e) => setCountry(e.target.value)} aria-label="País del banco">
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
          <select className="field" value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Banco">
            <option value="">{banks ? "Elige tu banco" : "Cargando bancos…"}</option>
            {banks?.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={busy || !choice}>
            {busy ? "Abriendo…" : "Conectar"}
          </button>
        </form>
      )}

      {data && (!src || editing) && src !== "secret" && (
        <>
          <Steps
            items={[
              "Entra en enablebanking.com, crea una cuenta gratuita y abre el Control Panel.",
              "Applications > Add a new application: entorno Production, nombre Marlon, y como Redirect URL esta dirección:",
            ]}
          >
            <CopyField value={data.bank.redirectUri} />
            <ol start={3}>
              <li>Al crearla, el navegador descarga la clave privada (un archivo .pem). Guárdala: no se puede volver a descargar.</li>
              <li>En la aplicación, pulsa Link accounts y entra en cada banco que quieras usar (por ejemplo tu banco finlandés y BBVA): en uso personal, Marlon solo puede leer las cuentas que enlaces ahí.</li>
              <li>Copia el Application ID y pégalo abajo junto con el archivo .pem.</li>
            </ol>
            <p className="muted small">Es gratis para tus propias cuentas. Marlon solo lee: no puede hacer pagos ni transferencias.</p>
          </Steps>
          <form
            className="s-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.saveConnection("enable-banking", { appId: appId.trim(), privateKey: pem })).then((ok) => {
                if (ok) {
                  setAppId("");
                  setPem("");
                  setEditing(false);
                  setMsg({ text: "Aplicación comprobada. Ahora elige tu banco." });
                  onChange();
                }
              });
            }}
          >
            <input className="field" placeholder="Application ID" value={appId} onChange={(e) => setAppId(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <label className="file-pick">
              <input
                type="file"
                accept=".pem,application/x-pem-file,application/x-x509-ca-cert,text/plain"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void f.text().then(setPem);
                }}
              />
              <span>{pem ? "Clave privada cargada" : "Elegir el archivo .pem"}</span>
            </label>
            <textarea className="field area" placeholder="…o pega aquí el contenido del .pem" value={pem} onChange={(e) => setPem(e.target.value)} rows={3} spellCheck={false} />
            <div className="actions-row">
              <button className="btn" disabled={busy || appId.trim().length < 8 || pem.length < 100}>
                {busy ? "Comprobando…" : "Guardar aplicación"}
              </button>
              {editing && (
                <>
                  <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => window.confirm("¿Quitar la aplicación de Enable Banking?") && void run(() => api.deleteConnection("enable-banking")).then(onChange)}
                  >
                    Quitar
                  </button>
                </>
              )}
            </div>
          </form>
        </>
      )}
      {msg && <p className={`s-msg ${msg.err ? "err" : ""}`}>{msg.text}</p>}
    </div>
  );
}
