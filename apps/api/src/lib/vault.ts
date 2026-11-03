import type { Env } from "../env";

/**
 * Cofre para valores privados que se configuran desde la app.
 * Cifrado AES-GCM con una clave derivada (HKDF) de SESSION_SECRET: aunque alguien
 * leyera la base de datos D1, no vería el valor.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function vaultKey(env: Env): Promise<CryptoKey> {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("Falta SESSION_SECRET (mínimo 32 caracteres).");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("marlon-vault-v1"), info: enc.encode("secure_values") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function putSecure(env: Env, key: string, value: string): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(key) }, await vaultKey(env), enc.encode(value)),
  );
  await env.DB.prepare(
    `INSERT INTO secure_values (key, iv, ciphertext, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(key) DO UPDATE SET iv = ?2, ciphertext = ?3, updated_at = ?4`,
  )
    .bind(key, b64(iv), b64(data), new Date().toISOString())
    .run();
}

export async function getSecure(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT iv, ciphertext FROM secure_values WHERE key = ?`)
    .bind(key)
    .first<{ iv: string; ciphertext: string }>();
  if (!row) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(row.iv), additionalData: enc.encode(key) },
      await vaultKey(env),
      unb64(row.ciphertext),
    );
    return dec.decode(plain);
  } catch {
    // SESSION_SECRET cambió: el valor ya no se puede leer y hay que volver a guardarlo.
    return null;
  }
}

export async function deleteSecure(env: Env, key: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM secure_values WHERE key = ?`).bind(key).run();
}
