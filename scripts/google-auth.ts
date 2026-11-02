/**
 * Obtiene el refresh token de Google Calendar una sola vez.
 *
 * Uso:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... pnpm google:auth
 * (o con esos valores en apps/api/.dev.vars)
 *
 * El cliente OAuth debe ser de tipo "Aplicación de escritorio" para que se
 * permita la redirección a 127.0.0.1. El token NO se guarda en ningún archivo:
 * se imprime para que lo subas con `wrangler secret put GOOGLE_REFRESH_TOKEN`.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
// Solo eventos: Marlon no necesita gestionar calendarios ni compartirlos.
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

function fromDevVars(key: string): string | undefined {
  const file = new URL("../apps/api/.dev.vars", import.meta.url);
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] === key) return m[2]!.replace(/^["']|["']$/g, "") || undefined;
  }
  return undefined;
}

const clientId = process.env.GOOGLE_CLIENT_ID ?? fromDevVars("GOOGLE_CLIENT_ID");
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? fromDevVars("GOOGLE_CLIENT_SECRET");
if (!clientId || !clientSecret) {
  console.error("Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (en el entorno o en apps/api/.dev.vars).");
  process.exit(1);
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== state || !code) {
    res.writeHead(400).end("Respuesta no válida.");
    return;
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const data = (await tokenRes.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!data.refresh_token) {
    res.writeHead(500).end("No llegó el refresh token. Mira la terminal.");
    console.error("Error:", data.error, data.error_description ?? "");
    console.error("Si ya habías autorizado antes, revoca el acceso en https://myaccount.google.com/permissions y repite.");
    server.close();
    process.exit(1);
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Listo. Ya puedes cerrar esta pestaña.");
  console.log("\nRefresh token obtenido. Súbelo como secreto (no lo guardes en el repo):\n");
  console.log("  pnpm --filter @marlon/api exec wrangler secret put GOOGLE_REFRESH_TOKEN\n");
  console.log("y pega este valor cuando te lo pida:\n");
  console.log(data.refresh_token);
  console.log("\nPara desarrollo local, ponlo en apps/api/.dev.vars como GOOGLE_REFRESH_TOKEN=...\n");
  server.close();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Abre esta URL en el navegador e inicia sesión con la cuenta de Google del calendario:\n");
  console.log(authUrl.toString());
  console.log(`\nEsperando la respuesta en ${REDIRECT} …`);
});
