import type { Env } from "../env";
import { deleteSecure, getSecureMany, putSecure } from "../lib/vault";

/**
 * Credenciales que se pueden configurar desde Ajustes (guardadas cifradas en D1)
 * en vez de como secretos de Cloudflare. Si existe el secreto, manda el secreto.
 */
export const STORED_CREDENTIALS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "YOUTUBE_API_KEY",
  "GOOGLE_MAPS_API_KEY",
] as const;
export type StoredCredential = (typeof STORED_CREDENTIALS)[number];

const vaultKey = (k: StoredCredential) => `cred:${k}`;

/** Devuelve el entorno con las credenciales guardadas desde la app añadidas. */
export async function withStoredCredentials(env: Env): Promise<Env> {
  const missing = STORED_CREDENTIALS.filter((k) => !env[k]);
  if (!missing.length) return env;
  try {
    const found = await getSecureMany(env, missing.map(vaultKey));
    if (!found.size) return env;
    const extra: Partial<Env> = {};
    for (const k of missing) {
      const v = found.get(vaultKey(k));
      if (v) extra[k] = v;
    }
    return { ...env, ...extra };
  } catch {
    // Sin SESSION_SECRET o sin la tabla (migración pendiente): se sigue con lo que hay.
    return env;
  }
}

export type CredentialSource = "secret" | "app" | null;

/** De dónde sale cada credencial, sin revelar su valor. */
export async function credentialSources(env: Env): Promise<Record<StoredCredential, CredentialSource>> {
  const found = await getSecureMany(env, STORED_CREDENTIALS.map(vaultKey)).catch(() => new Map<string, string>());
  const out = {} as Record<StoredCredential, CredentialSource>;
  for (const k of STORED_CREDENTIALS) {
    const stored = found.get(vaultKey(k));
    // El entorno puede venir ya completado con lo guardado: si coincide, es de la app.
    out[k] = env[k] && env[k] !== stored ? "secret" : stored ? "app" : null;
  }
  return out;
}

export const saveCredential = (env: Env, k: StoredCredential, value: string) => putSecure(env, vaultKey(k), value);
export const deleteCredential = (env: Env, k: StoredCredential) => deleteSecure(env, vaultKey(k));
