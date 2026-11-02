/**
 * Genera las claves VAPID para las notificaciones push.
 * Uso: pnpm vapid:generate
 * No se guardan en ningún archivo: súbelas como secretos del Worker.
 */
const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log("Claves VAPID nuevas. Súbelas como secretos (no las guardes en el repo):\n");
console.log("  pnpm --filter @marlon/api exec wrangler secret put VAPID_PUBLIC_KEY");
console.log(`  → ${b64url(raw)}\n`);
console.log("  pnpm --filter @marlon/api exec wrangler secret put VAPID_PRIVATE_KEY");
console.log(`  → ${jwk.d}\n`);
console.log("  pnpm --filter @marlon/api exec wrangler secret put VAPID_SUBJECT");
console.log("  → mailto:tu-correo@ejemplo.com\n");
console.log("Si cambias las claves, hay que volver a activar las notificaciones en el iPhone.");
