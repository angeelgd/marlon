import type { Env } from "../env";
import { deleteSecure, getSecure, putSecure } from "../lib/vault";
import { BankError } from "./enable-banking";
import { bankClient, saveLink } from "./sync";

const PENDING_KEY = "oauth:bank:pending";
const PENDING_MINUTES = 15;
/** Lo máximo que permite PSD2 hoy; si el banco admite menos, se usa lo suyo. */
const MAX_CONSENT_DAYS = 180;
export const BANK_CALLBACK_PATH = "/api/bank/callback";

const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/[+/=]/g, "");

export async function startBankAuth(
  env: Env,
  origin: string,
  aspsp: { name: string; country: string; maximumConsentSeconds?: number },
  now = Date.now(),
): Promise<string> {
  const client = bankClient(env);
  if (!client) throw new BankError("Primero guarda el id de la aplicación y la clave privada de Enable Banking.");
  const maxMs = Math.min(MAX_CONSENT_DAYS * 86_400_000, (aspsp.maximumConsentSeconds ?? Infinity) * 1000);
  const validUntil = new Date(now + maxMs - 60_000).toISOString();
  const state = random();
  await putSecure(env, PENDING_KEY, JSON.stringify({ state, aspsp: { name: aspsp.name, country: aspsp.country }, exp: now + PENDING_MINUTES * 60_000 }));
  return client.startAuth({ aspsp: { name: aspsp.name, country: aspsp.country }, redirectUrl: `${origin}${BANK_CALLBACK_PATH}`, state, validUntil });
}

/** Vuelta desde el banco. Igual que con Google: sin cookie, protegida por un state de un solo uso. */
export async function finishBankAuth(env: Env, params: URLSearchParams, fetchImpl?: typeof fetch): Promise<{ linkId: string; accounts: number }> {
  const raw = await getSecure(env, PENDING_KEY);
  await deleteSecure(env, PENDING_KEY);
  const pending = raw ? (JSON.parse(raw) as { state: string; aspsp: { name: string; country: string }; exp: number }) : null;
  if (params.get("error")) {
    const d = params.get("error_description") || params.get("error");
    throw new BankError(params.get("error") === "access_denied" ? "Has cancelado el permiso en el banco." : `El banco respondió: ${d}.`);
  }
  if (!pending || pending.exp < Date.now() || params.get("state") !== pending.state) {
    throw new BankError("La conexión con el banco ha caducado o no es válida. Vuelve a empezar desde Ajustes.");
  }
  const code = params.get("code");
  if (!code) throw new BankError("El banco no ha devuelto el código de autorización.");
  const client = bankClient(env, fetchImpl);
  if (!client) throw new BankError("Faltan las credenciales de Enable Banking.");
  const session = await client.createSession(code);
  if (!session.accounts.length) {
    throw new BankError("El banco no ha compartido ninguna cuenta. En modo personal, enlaza antes la cuenta en el panel de Enable Banking.");
  }
  const linkId = await saveLink(env.DB, session, pending.aspsp);
  return { linkId, accounts: session.accounts.length };
}
