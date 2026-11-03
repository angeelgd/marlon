import { afterEach, describe, expect, it, vi } from "vitest";
import { EnableBanking } from "../src/bank/enable-banking";
import { GoogleBackend } from "../src/calendar/backend";
import { testEnv } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

/** Como en Workers: fetch falla si se llama con otro `this`. */
function strictFetch(body: unknown) {
  return vi.fn(function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
}

describe("fetch por defecto", () => {
  it("Enable Banking no llama a fetch como método", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
    vi.stubGlobal("fetch", strictFetch({ aspsps: [{ name: "BBVA", country: "ES" }] }));
    expect(await new EnableBanking("app-1", pem).aspsps("ES")).toHaveLength(1);
  });

  it("Google Calendar no llama a fetch como método", async () => {
    vi.stubGlobal("fetch", strictFetch({ items: [], nextSyncToken: "t", access_token: "a", expires_in: 3600 }));
    const b = new GoogleBackend(testEnv({ GOOGLE_CLIENT_ID: "i", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r-binding" }), "primary", "Europe/Helsinki");
    await expect(b.listChanges(null, "2026-11-01T00:00:00Z")).resolves.toMatchObject({ nextSyncToken: "t" });
  });
});
