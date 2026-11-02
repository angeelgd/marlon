import { createECDH, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
// Implementación de referencia (la que usa la librería web-push de Node) para descifrar.
// @ts-expect-error sin tipos
import ece from "http_ece";
import { b64urlDecode, b64urlEncode, encryptPayload, generateKeyPair, sendPush, vapidAuthorization } from "../src/push/webpush";

/** Vectores del ejemplo del RFC 8291, apéndice A. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function decryptWithReference(body: Uint8Array, uaPrivate: string, uaPublic: string, auth: string): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(b64urlDecode(uaPrivate)));
  void uaPublic;
  return ece
    .decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ecdh, authSecret: Buffer.from(b64urlDecode(auth)) })
    .toString("utf8");
}

describe("Web Push: cifrado (RFC 8291)", () => {
  it("reproduce exactamente el ejemplo del RFC 8291", async () => {
    const body = await encryptPayload(new TextEncoder().encode(RFC.plaintext), RFC.uaPublic, RFC.auth, {
      salt: b64urlDecode(RFC.salt),
      serverKeys: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
    });
    expect(b64urlEncode(body)).toBe(RFC.body);
  });

  it("la implementación de referencia descifra un mensaje con claves aleatorias", async () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const uaPublic = b64urlEncode(ecdh.getPublicKey());
    const uaPrivate = b64urlEncode(ecdh.getPrivateKey());
    const auth = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const msg = JSON.stringify({ title: "Marlon", body: "Sal en 10 min para el trabajo 🚌" });
    const body = await encryptPayload(new TextEncoder().encode(msg), uaPublic, auth);
    expect(decryptWithReference(body, uaPrivate, uaPublic, auth)).toBe(msg);
  });
});

describe("Web Push: VAPID (RFC 8292)", () => {
  it("firma un JWT ES256 válido con la audiencia del servicio de push", async () => {
    const vapid = { ...(await generateKeyPair()), subject: "mailto:yo@example.com" };
    const now = Date.parse("2026-11-02T10:00:00Z");
    const header = await vapidAuthorization("https://web.push.apple.com/QGuQyavXut/abc", vapid, now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m).not.toBeNull();
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2]!)));
    expect(payload).toEqual({ aud: "https://web.push.apple.com", exp: Math.floor(now / 1000) + 43200, sub: "mailto:yo@example.com" });
    expect(m[4]).toBe(vapid.publicKey);

    // Verificación independiente con node:crypto (firma r||s = ieee-p1363).
    const raw = b64urlDecode(vapid.publicKey);
    const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33)) };
    const ok = createVerify("SHA256")
      .update(`${m[1]}.${m[2]}`)
      .verify({ key: jwk, format: "jwk", dsaEncoding: "ieee-p1363" }, Buffer.from(b64urlDecode(m[3]!)));
    expect(ok).toBe(true);
  });
});

describe("Web Push: envío", () => {
  it("manda las cabeceras correctas y detecta suscripciones caducadas", async () => {
    const vapid = { ...(await generateKeyPair()), subject: "mailto:yo@example.com" };
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const sub = {
      endpoint: "https://push.example.com/send/xyz",
      p256dh: b64urlEncode(ecdh.getPublicKey()),
      auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    };
    let seen: { headers: Record<string, string>; body: Uint8Array } | null = null;
    const fetchOk = (async (_url: string, init: RequestInit) => {
      seen = { headers: init.headers as Record<string, string>, body: init.body as Uint8Array };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    expect(await sendPush(sub, { title: "Hola" }, vapid, { fetchImpl: fetchOk, topic: "nudge:abc 1", urgency: "high" })).toEqual({ ok: true });
    expect(seen!.headers).toMatchObject({ "content-encoding": "aes128gcm", urgency: "high", topic: "nudgeabc1" });
    expect(seen!.headers.authorization).toMatch(/^vapid t=/);
    expect(decryptWithReference(seen!.body, b64urlEncode(ecdh.getPrivateKey()), sub.p256dh, sub.auth)).toBe('{"title":"Hola"}');

    const fetchGone = (async () => new Response("gone", { status: 410 })) as unknown as typeof fetch;
    expect(await sendPush(sub, {}, vapid, { fetchImpl: fetchGone })).toMatchObject({ ok: false, gone: true, status: 410 });
  });
});
