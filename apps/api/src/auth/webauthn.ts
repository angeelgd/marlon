import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthStatus } from "@marlon/shared";
import type { Env } from "../env";
import { newId } from "../lib/ids";
import { createSession, destroySession, devBypass, readSession, safeEqual } from "./session";

type C = Context<{ Bindings: Env }>;

const CHALLENGE_COOKIE = "marlon_challenge";
const CHALLENGE_MINUTES = 5;

function rp(c: C) {
  const url = new URL(c.req.url);
  return { rpID: url.hostname, origin: url.origin };
}

async function storeChallenge(c: C, challenge: string, kind: "register" | "login") {
  const id = newId("chl");
  const expires = new Date(Date.now() + CHALLENGE_MINUTES * 60_000).toISOString();
  await c.env.DB.prepare(`DELETE FROM auth_challenges WHERE expires_at < ?`).bind(new Date().toISOString()).run();
  await c.env.DB.prepare(`INSERT INTO auth_challenges (id, challenge, kind, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(id, challenge, kind, expires)
    .run();
  setCookie(c, CHALLENGE_COOKIE, id, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    path: "/api/auth",
    maxAge: CHALLENGE_MINUTES * 60,
  });
}

async function takeChallenge(c: C, kind: "register" | "login"): Promise<string | null> {
  const id = getCookie(c, CHALLENGE_COOKIE);
  if (!id) return null;
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/api/auth" });
  const row = await c.env.DB.prepare(`SELECT challenge, kind, expires_at FROM auth_challenges WHERE id = ?`)
    .bind(id)
    .first<{ challenge: string; kind: string; expires_at: string }>();
  await c.env.DB.prepare(`DELETE FROM auth_challenges WHERE id = ?`).bind(id).run();
  if (!row || row.kind !== kind || row.expires_at < new Date().toISOString()) return null;
  return row.challenge;
}

async function credentialCount(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM credentials`).first<{ n: number }>();
  return r?.n ?? 0;
}

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get("/status", async (c) => {
  const status: AuthStatus = {
    authenticated: devBypass(c) || (await readSession(c)) !== null,
    hasCredentials: (await credentialCount(c.env.DB)) > 0,
  };
  return c.json(status);
});

/**
 * Registro de una passkey. Exige el SETUP_TOKEN. Si ya hay alguna passkey,
 * además hace falta estar dentro (así el token deja de servir a terceros).
 */
authRoutes.post("/register/options", async (c) => {
  const body = await c.req.json<{ setupToken?: string }>().catch(() => ({}) as { setupToken?: string });
  if (!c.env.SETUP_TOKEN || !body.setupToken || !safeEqual(body.setupToken, c.env.SETUP_TOKEN)) {
    return c.json({ error: "Código de configuración incorrecto." }, 403);
  }
  if ((await credentialCount(c.env.DB)) > 0 && !(await readSession(c))) {
    return c.json({ error: "Ya hay una passkey. Entra con ella para añadir otra." }, 403);
  }
  const { rpID } = rp(c);
  const { results } = await c.env.DB.prepare(`SELECT id, transports FROM credentials`).all<{ id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: "Marlon",
    rpID,
    userName: "angel",
    userDisplayName: "Ángel",
    userID: new Uint8Array(new TextEncoder().encode("marlon-owner")),
    attestationType: "none",
    excludeCredentials: results.map((r) => ({ id: r.id, transports: r.transports ? JSON.parse(r.transports) : undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  await storeChallenge(c, options.challenge, "register");
  return c.json(options);
});

authRoutes.post("/register/verify", async (c) => {
  const expectedChallenge = await takeChallenge(c, "register");
  if (!expectedChallenge) return c.json({ error: "El reto ha caducado. Vuelve a empezar." }, 400);
  const { rpID, origin } = rp(c);
  try {
    const verification = await verifyRegistrationResponse({
      response: await c.req.json(),
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
    if (!verification.verified) return c.json({ error: "No se pudo verificar la passkey." }, 400);
    const cred = verification.registrationInfo.credential;
    await c.env.DB.prepare(`INSERT INTO credentials (id, public_key, counter, transports) VALUES (?, ?, ?, ?)`)
      .bind(cred.id, isoBase64URL.fromBuffer(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []))
      .run();
    await createSession(c);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

authRoutes.post("/login/options", async (c) => {
  const options = await generateAuthenticationOptions({ rpID: rp(c).rpID, userVerification: "preferred" });
  await storeChallenge(c, options.challenge, "login");
  return c.json(options);
});

authRoutes.post("/login/verify", async (c) => {
  const expectedChallenge = await takeChallenge(c, "login");
  if (!expectedChallenge) return c.json({ error: "El reto ha caducado. Vuelve a empezar." }, 400);
  const response = await c.req.json<{ id: string }>();
  const row = await c.env.DB.prepare(`SELECT id, public_key, counter, transports FROM credentials WHERE id = ?`)
    .bind(response.id)
    .first<{ id: string; public_key: string; counter: number; transports: string | null }>();
  if (!row) return c.json({ error: "Passkey desconocida." }, 400);
  const { rpID, origin } = rp(c);
  try {
    const verification = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: row.id,
        publicKey: isoBase64URL.toBuffer(row.public_key),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
    });
    if (!verification.verified) return c.json({ error: "No se pudo verificar la passkey." }, 401);
    await c.env.DB.prepare(`UPDATE credentials SET counter = ? WHERE id = ?`)
      .bind(verification.authenticationInfo.newCounter, row.id)
      .run();
    await createSession(c);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 401);
  }
});

authRoutes.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});
