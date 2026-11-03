import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { merchantKey, ruleCategory } from "../src/bank/categorize";
import { amountToCents, pemToPkcs8, pickBalance, signJwt } from "../src/bank/enable-banking";
import { recategorizeExpense } from "../src/bank/recategorize";
import { bankStatus, syncBank } from "../src/bank/sync";
import { saveCredential } from "../src/integrations/credentials";
import { addExpense, listExpenses } from "../src/money/expenses";
import { testEnv } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

async function rsaPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, publicKey: kp.publicKey };
}

const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

describe("firma para Enable Banking", () => {
  it("crea un JWT RS256 con kid = id de la aplicación que se verifica con la clave pública", async () => {
    const { pem, publicKey } = await rsaPem();
    const jwt = await signJwt("app-123", pem, Date.parse("2026-11-03T10:00:00Z"));
    const [h, b, sig] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(unb64url(h!)))).toEqual({ typ: "JWT", alg: "RS256", kid: "app-123" });
    const body = JSON.parse(new TextDecoder().decode(unb64url(b!)));
    expect(body).toMatchObject({ iss: "enablebanking.com", aud: "api.enablebanking.com" });
    expect(body.exp - body.iat).toBe(3600);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, unb64url(sig!), new TextEncoder().encode(`${h}.${b}`));
    expect(ok).toBe(true);
  });

  it("acepta el PEM pegado con \\n literales y rechaza lo que no es un PEM", async () => {
    const { pem } = await rsaPem();
    expect(pemToPkcs8(pem.replace(/\n/g, "\\n")).length).toBeGreaterThan(1000);
    expect(() => pemToPkcs8("hola")).toThrow(/archivo \.pem/);
  });

  it("importes y saldos", () => {
    expect(amountToCents({ amount: "12.30" })).toBe(1230);
    expect(amountToCents({ amount: "-4,5" })).toBe(450);
    expect(pickBalance([{ balance_type: "CLBD", balance_amount: { amount: "100.00" } }, { balance_type: "ITAV", balance_amount: { amount: "80.10", currency: "EUR" } }])).toEqual({ cents: 8010, currency: "EUR" });
  });
});

describe("categorías", () => {
  it("reglas para comercios de Finlandia y clave de comercio estable", () => {
    expect(ruleCategory("K-Market Herttua Turku")).toBe("groceries");
    expect(ruleCategory("WOLT")).toBe("eating_out");
    expect(ruleCategory("Föli")).toBe("transport");
    expect(ruleCategory("Spotify P1234")).toBe("subscriptions");
    expect(ruleCategory("Apteekki Kupittaa")).toBe("health");
    expect(ruleCategory("COMPRA EN MERCADONA VALENCIA")).toBe("groceries");
    expect(ruleCategory("Glovo")).toBe("eating_out");
    expect(ruleCategory("RENFE VIAJEROS")).toBe("transport");
    expect(ruleCategory("Iberdrola clientes")).toBe("utilities");
    expect(ruleCategory("Cosa rara Oy")).toBeNull();
    expect(merchantKey("PAYPAL *SPOTIFY 4029357733")).toBe(merchantKey("PayPal *Spotify 1111"));
  });

  it("corregir un gasto del banco aprende el comercio y arregla los demás en Otros", async () => {
    const env = testEnv();
    const a = await addExpense(env.DB, { date: "2026-11-01", amountCents: 990, merchant: "Kauppa Oy 123", category: "other", source: "bank" });
    await addExpense(env.DB, { date: "2026-11-02", amountCents: 500, merchant: "Kauppa Oy 456", category: "other", source: "bank" });
    expect(await recategorizeExpense(env.DB, a.id, "groceries")).toEqual({ updated: 2 });
    expect((await listExpenses(env.DB, "2026-11-01", "2026-11-30")).every((e) => e.category === "groceries")).toBe(true);
  });
});

/** API de Enable Banking simulada. */
function fakeBank(state: { txs: unknown[]; pending?: unknown[]; balance?: string }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer ey/);
    if (u.pathname === "/aspsps") return new Response(JSON.stringify({ aspsps: [{ name: "Nordea", country: "FI", psu_types: ["personal"], maximum_consent_validity: 15552000 }] }));
    if (u.pathname === "/auth") return new Response(JSON.stringify({ url: "https://tilisy.enablebanking.com/welcome?x=1" }));
    if (u.pathname === "/sessions") {
      return new Response(JSON.stringify({ session_id: "ses-1", accounts: [{ uid: "acc-1", account_id: { iban: "FI2112345600000785" }, name: "Käyttötili", currency: "EUR" }], access: { valid_until: "2027-05-01T00:00:00Z" }, aspsp: { name: "Nordea", country: "FI" } }));
    }
    if (u.pathname.endsWith("/balances")) return new Response(JSON.stringify({ balances: [{ balance_type: "ITAV", balance_amount: { amount: state.balance ?? "1234.56", currency: "EUR" } }] }));
    if (u.pathname.endsWith("/transactions")) return new Response(JSON.stringify({ transactions: [...state.txs, ...(state.pending ?? [])] }));
    return new Response("{}", { status: 404 });
  });
}

const tx = (ref: string, date: string, amount: string, dir: "DBIT" | "CRDT", who: string, extra: Record<string, unknown> = {}) => ({
  entry_reference: ref,
  booking_date: date,
  status: "BOOK",
  transaction_amount: { amount, currency: "EUR" },
  credit_debit_indicator: dir,
  ...(dir === "DBIT" ? { creditor: { name: who } } : { debtor: { name: who } }),
  remittance_information: [`${who} compra`],
  ...extra,
});

describe("conexión y sincronización del banco", () => {
  it("flujo completo: credenciales comprobadas, permiso con state de un solo uso y gastos sin duplicar", async () => {
    const env = testEnv({ DEV_AUTH_BYPASS: "1" });
    const { pem } = await rsaPem();
    const state = {
      txs: [
        tx("r1", "2026-11-01", "23.40", "DBIT", "K-Market Herttua"),
        tx("r2", "2026-11-02", "4.50", "DBIT", "Espresso House"),
        tx("r3", "2026-11-02", "1500.00", "CRDT", "Työnantaja Oy"),
        tx("r4", "2026-11-03", "200.00", "DBIT", "Ángel ahorro", { creditor_account: { iban: "FI21 1234 5600 0007 85" } }),
      ],
      pending: [{ transaction_id: "p1", status: "PDNG", transaction_amount: { amount: "9.99" }, credit_debit_indicator: "DBIT", creditor: { name: "Spotify" }, value_date: "2026-11-03" }],
    };
    vi.stubGlobal("fetch", fakeBank(state));
    const put = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await app.request("http://localhost:8787/api/connections/enable-banking", put({ appId: "app-12345678", privateKey: pem }), env)).status).toBe(200);

    // Ya apuntó el café a mano: el banco lo enlaza en vez de duplicarlo.
    await addExpense(env.DB, { date: "2026-11-02", amountCents: 450, merchant: "Café", category: "coffee", source: "voice" });

    const start = await app.request("http://localhost:8787/api/bank/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Nordea", country: "FI", maximumConsentSeconds: 15552000 }) }, env);
    expect(((await start.json()) as { url: string }).url).toMatch(/enablebanking/);
    const authCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([u]) => String(u).endsWith("/auth"))!;
    const authBody = JSON.parse(String((authCall[1] as RequestInit).body));
    expect(authBody).toMatchObject({ aspsp: { name: "Nordea", country: "FI" }, psu_type: "personal", redirect_url: "http://localhost:8787/api/bank/callback" });

    const bad = await app.request(`http://localhost:8787/api/bank/callback?code=c&state=otro`, {}, testEnv({ DB: env.DB }));
    expect(bad.headers.get("location")).toMatch(/connect_error/);
    // El state se consumió: hay que volver a empezar.
    await app.request("http://localhost:8787/api/bank/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Nordea", country: "FI" }) }, env);
    const authCall2 = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).endsWith("/auth")).at(-1)!;
    const goodState = JSON.parse(String((authCall2[1] as RequestInit).body)).state;
    const done = await app.request(`http://localhost:8787/api/bank/callback?code=c&state=${goodState}`, {}, testEnv({ DB: env.DB, SESSION_SECRET: env.SESSION_SECRET }));
    expect(done.headers.get("location")).toMatch(/^\/\?connected=bank&accounts=1&expenses=1/);

    const exp = await listExpenses(env.DB, "2026-11-01", "2026-11-30");
    expect(exp.map((e) => [e.merchant, e.amountCents, e.category, e.source]).sort()).toEqual([
      ["Café", 450, "coffee", "voice"],
      ["K-Market Herttua", 2340, "groceries", "bank"],
    ]);
    const status = await bankStatus(await (await import("../src/integrations/credentials")).withStoredCredentials(env));
    expect(status.links[0]).toMatchObject({ bank: "Nordea", status: "active" });
    expect(status.links[0]!.accounts[0]).toMatchObject({ balanceCents: 123456, iban: "FI21 •••• 0785" });

    // Segunda descarga: nada nuevo, el pendiente se rehace sin duplicar.
    const again = await syncBank(await (await import("../src/integrations/credentials")).withStoredCredentials(env));
    expect(again).toMatchObject({ newTransactions: 0, newExpenses: 0, errors: [] });
    const pend = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'pending'`).first("n");
    expect(pend).toBe(1);
    const own = await env.DB.prepare(`SELECT kind FROM bank_transactions WHERE id = 'acc-1:r4'`).first("kind");
    expect(own).toBe("own_transfer");
  });

  it("un permiso caducado se marca y se avisa", async () => {
    const env = testEnv();
    const { pem } = await rsaPem();
    await saveCredential(env, "ENABLE_BANKING_APP_ID", "app-12345678");
    await saveCredential(env, "ENABLE_BANKING_PRIVATE_KEY", pem);
    await env.DB.prepare(`INSERT INTO bank_links (id, session_id, aspsp_name, aspsp_country, valid_until) VALUES ('b1', 's1', 'OP', 'FI', '2026-01-01T00:00:00Z')`).run();
    vi.stubGlobal("fetch", fakeBank({ txs: [] }));
    const r = await syncBank(await (await import("../src/integrations/credentials")).withStoredCredentials(env), { now: Date.parse("2026-11-03T10:00:00Z") });
    expect(r.errors[0]).toMatch(/caducado/);
    expect(await env.DB.prepare(`SELECT status FROM bank_links WHERE id = 'b1'`).first("status")).toBe("expired");
  });
});
