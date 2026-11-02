/**
 * Web Push sin dependencias, con WebCrypto (disponible en Workers):
 * - Cifrado del mensaje: RFC 8291 (Message Encryption for Web Push) con aes128gcm (RFC 8188).
 * - Autenticación del servidor: VAPID (RFC 8292) con JWT ES256.
 */

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Clave pública P-256 sin comprimir (65 bytes) → JWK (x, y). */
function publicJwk(raw: Uint8Array): { x: string; y: string } {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Clave pública P-256 no válida.");
  return { x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)) };
}

export interface KeyPairB64 {
  /** Pública sin comprimir (65 bytes), base64url. */
  publicKey: string;
  /** Privada (d, 32 bytes), base64url. */
  privateKey: string;
}

async function importPrivate(pair: KeyPairB64, usage: "ecdh" | "sign"): Promise<CryptoKey> {
  const { x, y } = publicJwk(b64urlDecode(pair.publicKey));
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: pair.privateKey, x, y, ext: true },
    usage === "ecdh" ? { name: "ECDH", namedCurve: "P-256" } : { name: "ECDSA", namedCurve: "P-256" },
    false,
    usage === "ecdh" ? ["deriveBits"] : ["sign"],
  );
}

/** Genera un par de claves P-256 (para VAPID o pruebas). */
export async function generateKeyPair(): Promise<KeyPairB64> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { publicKey: b64urlEncode(raw), privateKey: jwk.d! };
}

export interface EncryptOptions {
  /** Solo para pruebas con vectores fijos. */
  salt?: Uint8Array<ArrayBuffer>;
  serverKeys?: KeyPairB64;
  recordSize?: number;
}

/**
 * Cifra el mensaje para una suscripción (p256dh y auth en base64url).
 * Devuelve el cuerpo aes128gcm listo para enviar.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  auth: string,
  opts: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const server = opts.serverKeys ?? (await generateKeyPair());
  const asPublic = b64urlDecode(server.publicKey);

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const asPrivate = await importPrivate(server, "ecdh");
  // El nombre estándar del parámetro es "public" (los tipos de Workers lo declaran distinto).
  const ecdhParams = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, asPrivate, 256));

  // RFC 8291 §3.4
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  // RFC 8188 §2.2 y §2.3
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const rs = opts.recordSize ?? 4096;
  // Un solo registro: datos + delimitador 0x02 (último registro), sin relleno.
  if (plaintext.length + 1 + 16 > rs) throw new Error("Mensaje demasiado largo para una notificación.");
  const padded = concat(plaintext, new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

/** Cabecera Authorization de VAPID (RFC 8292). */
export async function vapidAuthorization(
  endpoint: string,
  vapid: KeyPairB64 & { subject: string },
  now = Date.now(),
): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64urlEncode(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: vapid.subject,
      }),
    ),
  );
  const unsigned = `${header}.${payload}`;
  const key = await importPrivate(vapid, "sign");
  // WebCrypto devuelve la firma en formato r||s (64 bytes), que es justo el de JWS ES256.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

export interface PushSubscriptionData {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type SendResult = { ok: true } | { ok: false; status: number; gone: boolean; error: string };

export async function sendPush(
  sub: PushSubscriptionData,
  message: unknown,
  vapid: KeyPairB64 & { subject: string },
  opts: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string; fetchImpl?: typeof fetch } = {},
): Promise<SendResult> {
  const body = await encryptPayload(enc.encode(JSON.stringify(message)), sub.p256dh, sub.auth);
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-encoding": "aes128gcm",
    ttl: String(opts.ttl ?? 3600),
    urgency: opts.urgency ?? "normal",
    authorization: await vapidAuthorization(sub.endpoint, vapid),
  };
  // Topic sustituye en el servidor de push a un aviso anterior con el mismo tema.
  if (opts.topic) headers.topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const res = await (opts.fetchImpl ?? fetch)(sub.endpoint, { method: "POST", headers, body });
  if (res.ok) return { ok: true };
  return {
    ok: false,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
    error: (await res.text().catch(() => "")).slice(0, 200),
  };
}
