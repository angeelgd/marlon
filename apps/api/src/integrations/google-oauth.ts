import type { Env } from "../env";
import { deleteSecure, getSecure, putSecure } from "../lib/vault";
import { saveCredential } from "./credentials";

/** Solo eventos: Marlon no necesita gestionar calendarios ni compartirlos. */
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const PENDING_KEY = "oauth:google:pending";
const PENDING_MINUTES = 10;
export const CALLBACK_PATH = "/api/google/callback";

export const redirectUri = (origin: string) => `${origin}${CALLBACK_PATH}`;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Prepara el flujo OAuth (con PKCE y state de un solo uso) y devuelve la URL de Google. */
export async function startGoogleAuth(env: Env, origin: string): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Primero guarda el ID y el secreto del cliente OAuth de Google.");
  }
  const state = random(24);
  const verifier = random(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await putSecure(env, PENDING_KEY, JSON.stringify({ state, verifier, exp: Date.now() + PENDING_MINUTES * 60_000 }));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Fuerza que Google devuelva un refresh token aunque ya se hubiera autorizado antes.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/**
 * Vuelta desde Google. No lleva cookie de sesión (es una navegación desde otro
 * sitio y la cookie es SameSite=Strict), así que la protege el state de un solo uso.
 */
export async function finishGoogleAuth(
  env: Env,
  origin: string,
  params: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const raw = await getSecure(env, PENDING_KEY);
  await deleteSecure(env, PENDING_KEY);
  const pending = raw ? (JSON.parse(raw) as { state: string; verifier: string; exp: number }) : null;
  if (params.get("error")) {
    throw new Error(params.get("error") === "access_denied" ? "Has cancelado el permiso en Google." : `Google respondió: ${params.get("error")}.`);
  }
  if (!pending || pending.exp < Date.now() || params.get("state") !== pending.state) {
    throw new Error("La conexión ha caducado o no es válida. Vuelve a pulsar Conectar.");
  }
  const code = params.get("code");
  if (!code) throw new Error("Google no ha devuelto el código de autorización.");

  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.refresh_token) {
    if (data.error === "redirect_uri_mismatch") throw new Error("La URL de redirección no está autorizada en Google Cloud. Añádela al cliente OAuth.");
    if (data.error === "invalid_client") throw new Error("El ID o el secreto del cliente OAuth no son correctos.");
    throw new Error(data.error_description || data.error || "Google no ha devuelto el permiso de acceso sin conexión.");
  }
  await saveCredential(env, "GOOGLE_REFRESH_TOKEN", data.refresh_token);
}
