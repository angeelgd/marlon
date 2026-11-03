import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import { api } from "../lib/api";

interface Props {
  hasCredentials: boolean;
  onDone(): void;
}

export function Login({ hasCredentials, onDone }: Props) {
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(!hasCredentials);

  async function login() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.loginOptions();
      const response = await startAuthentication({ optionsJSON: options as never });
      await api.loginVerify(response);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.registerOptions(setupToken.trim());
      const response = await startRegistration({ optionsJSON: options as never });
      await api.registerVerify(response);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-card">
      <span className="login-mark" aria-hidden>M</span>
      <h1>Marlon</h1>
      {registering ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void register();
          }}
        >
          <p>Primera vez: escribe el código de configuración y crea tu passkey.</p>
          <input
            className="field"
            type="text"
            placeholder="Código de configuración"
            value={setupToken}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setSetupToken(e.target.value)}
            autoComplete="one-time-code"
            required
          />
          <button className="btn block" disabled={busy || !setupToken}>{busy ? "…" : "Crear passkey"}</button>
          {hasCredentials && (
            <button type="button" className="link" onClick={() => setRegistering(false)}>Ya tengo passkey</button>
          )}
        </form>
      ) : (
        <>
          <p>Tu agenda, tu trabajo y tus planes, en orden.</p>
          <button className="btn block" onClick={login} disabled={busy}>{busy ? "…" : "Entrar con passkey"}</button>
          <button type="button" className="link" onClick={() => setRegistering(true)}>Registrar otra passkey</button>
        </>
      )}
      {error && <p className="chat-error">{error}</p>}
      </div>
    </main>
  );
}
