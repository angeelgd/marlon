import type { Env } from "../env";
import { deleteSecure, getSecure, putSecure } from "../lib/vault";

const VAULT_KEY = "university_ical_url";

export type UniversitySource = "secret" | "app" | null;

/**
 * Acepta lo que se copia de Lukkari/Peppi tal cual: con espacios, con webcal:// o http://.
 * Devuelve la URL https o lanza un error explicable.
 */
export function normalizeIcalUrl(input: string): string {
  let raw = input.trim().replace(/[\s​-‍﻿]/g, "");
  if (!raw) throw new Error("Pega el enlace del calendario.");
  if (/^webcals?:\/\//i.test(raw)) raw = raw.replace(/^webcals?:\/\//i, "https://");
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Eso no parece un enlace válido.");
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") throw new Error("El enlace tiene que empezar por https:// o webcal://.");
  return url.toString();
}

/** La URL configurada: primero el secreto de Cloudflare, si no, la guardada desde la app. */
export async function universityIcalUrl(env: Env): Promise<{ url: string | null; source: UniversitySource }> {
  if (env.UNIVERSITY_ICAL_URL) return { url: env.UNIVERSITY_ICAL_URL, source: "secret" };
  const stored = await getSecure(env, VAULT_KEY);
  return stored ? { url: stored, source: "app" } : { url: null, source: null };
}

export const saveUniversityIcalUrl = (env: Env, url: string) => putSecure(env, VAULT_KEY, url);
export const deleteUniversityIcalUrl = (env: Env) => deleteSecure(env, VAULT_KEY);

/** Solo el dominio, para mostrarlo sin revelar el hash= que hace de contraseña. */
export const maskedHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};
