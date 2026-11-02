import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../env";
import { newId } from "../lib/ids";

export const SESSION_COOKIE = "marlon_session";
const SESSION_DAYS = 30;

const enc = new TextEncoder();

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Comparación en tiempo constante. */
export function safeEqual(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function secret(env: Env): string {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("Falta SESSION_SECRET (mínimo 32 caracteres).");
  }
  return env.SESSION_SECRET;
}

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export async function createSession(c: Context<{ Bindings: Env }>): Promise<void> {
  const id = newId("ses");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await c.env.DB.prepare(`INSERT INTO sessions (id, expires_at) VALUES (?, ?)`).bind(id, expires.toISOString()).run();
  const value = `${id}.${await hmac(secret(c.env), id)}`;
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Strict",
    path: "/",
    expires,
  });
}

export async function readSession(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || !sig || !c.env.SESSION_SECRET) return null;
  if (!safeEqual(sig, await hmac(secret(c.env), id))) return null;
  const row = await c.env.DB.prepare(`SELECT expires_at FROM sessions WHERE id = ?`).bind(id).first<{ expires_at: string }>();
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return id;
}

export async function destroySession(c: Context<{ Bindings: Env }>): Promise<void> {
  const id = await readSession(c);
  if (id) await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Modo desarrollo: solo se permite saltar la autenticación en localhost. */
export function devBypass(c: Context<{ Bindings: Env }>): boolean {
  const host = new URL(c.req.url).hostname;
  return c.env.DEV_AUTH_BYPASS === "1" && (host === "localhost" || host === "127.0.0.1");
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (devBypass(c)) return next();
  const id = await readSession(c);
  if (!id) return c.json({ error: "No autenticado" }, 401);
  return next();
};
