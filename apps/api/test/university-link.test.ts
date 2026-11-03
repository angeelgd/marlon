import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { getSecure, putSecure } from "../src/lib/vault";
import { normalizeIcalUrl, universityIcalUrl } from "../src/university/source";
import { testEnv } from "./helpers";

const ICAL = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";
const base = "http://localhost:8787/api/university/link";
const put = (url: string) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });

afterEach(() => vi.unstubAllGlobals());

describe("enlace de la uni desde la app", () => {
  it("normaliza lo que se pega (webcal, espacios, sin esquema) y rechaza lo que no es un enlace", () => {
    expect(normalizeIcalUrl("  webcal://lukkari.turkuamk.fi/ical.php?hash=ABC \n")).toBe("https://lukkari.turkuamk.fi/ical.php?hash=ABC");
    expect(normalizeIcalUrl("lukkari.turkuamk.fi/ical.php?hash=ABC")).toBe("https://lukkari.turkuamk.fi/ical.php?hash=ABC");
    expect(normalizeIcalUrl("http://a.fi/x.ics")).toBe("https://a.fi/x.ics");
    expect(() => normalizeIcalUrl("")).toThrow();
    expect(() => normalizeIcalUrl("ftp://a.fi/x")).toThrow();
  });

  it("guarda cifrado: en la base de datos no aparece la URL", async () => {
    const env = testEnv();
    await putSecure(env, "k", "https://lukkari.example/ical?hash=SECRETO");
    const row = await env.DB.prepare(`SELECT ciphertext FROM secure_values WHERE key = 'k'`).first<{ ciphertext: string }>();
    expect(row!.ciphertext).not.toContain("SECRETO");
    expect(await getSecure(env, "k")).toBe("https://lukkari.example/ical?hash=SECRETO");
    // Con otro SESSION_SECRET no se puede leer.
    expect(await getSecure({ ...env, SESSION_SECRET: "y".repeat(40) }, "k")).toBeNull();
  });

  it("PUT comprueba que es un iCal, lo guarda, sincroniza y nunca devuelve la URL", async () => {
    const env = testEnv({ DEV_AUTH_BYPASS: "1" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>login</html>", { status: 200 })));
    const bad = await app.request(base, put("https://lukkari.example/web"), env);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/no devuelve un calendario/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(ICAL, { status: 200 })));
    const ok = await app.request(base, put("webcal://lukkari.example/ical?hash=SECRETO"), env);
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toContain("SECRETO");
    expect(JSON.parse(text)).toMatchObject({ configured: true, source: "app", host: "lukkari.example" });
    expect((await universityIcalUrl(env)).url).toBe("https://lukkari.example/ical?hash=SECRETO");

    const status = (await (await app.request(base, {}, env)).json()) as { configured: boolean };
    expect(status.configured).toBe(true);
    const del = (await (await app.request(base, { method: "DELETE", headers: { "content-type": "application/json" } }, env)).json()) as { configured: boolean };
    expect(del.configured).toBe(false);
  });

  it("si está como secreto de Cloudflare, manda el secreto y no se sobrescribe", async () => {
    const env = testEnv({ DEV_AUTH_BYPASS: "1", UNIVERSITY_ICAL_URL: "https://x.fi/ical?hash=S" });
    const res = await app.request(base, put("https://otra.fi/ical"), env);
    expect(res.status).toBe(409);
    expect(await (await app.request(base, {}, env)).json()).toMatchObject({ configured: true, source: "secret", host: "x.fi" });
  });
});
