/**
 * Cliente mínimo de Enable Banking (agregador PSD2 con sede en Finlandia).
 * Solo lectura: cuentas, saldos y movimientos. Cada petición va firmada con un
 * JWT RS256 hecho con la clave privada de la aplicación (WebCrypto, sin dependencias).
 */

export const ENABLE_BANKING_BASE = "https://api.enablebanking.com";

export class BankError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "BankError";
  }
}

/* ------------------------------------------------------------------ */
/* Firma                                                               */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}

/** Envuelve una clave RSA PKCS#1 ("BEGIN RSA PRIVATE KEY") en PKCS#8, que es lo que acepta WebCrypto. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const bodyLen = version.length + algId.length + octet.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(bodyLen), ...version, ...algId, ...octet, ...pkcs1]);
  return out;
}

/** Normaliza lo que se pega (con espacios, sin saltos de línea...) y devuelve los bytes PKCS#8. */
export function pemToPkcs8(pem: string): Uint8Array {
  const text = pem.replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]+?)-----END \1-----/.exec(text);
  if (!m) throw new BankError("La clave privada tiene que ser el archivo .pem completo, con las líneas BEGIN y END.");
  const bytes = Uint8Array.from(atob(m[2]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return m[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(bytes) : bytes;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(pem: string): Promise<CryptoKey> {
  let k = keyCache.get(pem);
  if (!k) {
    k = crypto.subtle
      .importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
      .catch(() => {
        keyCache.delete(pem);
        throw new BankError("No se ha podido leer la clave privada. Pega el archivo .pem que descargaste de Enable Banking.");
      });
    keyCache.set(pem, k);
  }
  return k;
}

export async function signJwt(appId: string, pem: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const head = b64urlJson({ typ: "JWT", alg: "RS256", kid: appId });
  const body = b64urlJson({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + 3600 });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importKey(pem), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/* ------------------------------------------------------------------ */
/* Tipos (solo los campos que usa Marlon; todo lo demás se ignora)     */
/* ------------------------------------------------------------------ */

export interface Aspsp {
  name: string;
  country: string;
  logo?: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
}

interface Amount {
  amount?: string | number;
  currency?: string;
}

export interface ApiAccount {
  uid?: string;
  account_id?: { iban?: string; other?: { identification?: string } };
  name?: string;
  details?: string;
  product?: string;
  currency?: string;
}

export interface ApiTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount?: Amount;
  credit_debit_indicator?: "DBIT" | "CRDT" | string;
  status?: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
  creditor_account?: { iban?: string | null } | null;
  debtor_account?: { iban?: string | null } | null;
  remittance_information?: string[] | string | null;
}

export interface ApiBalance {
  balance_amount?: Amount;
  balance_type?: string;
  reference_date?: string;
}

export interface SessionResult {
  session_id: string;
  accounts: ApiAccount[];
  valid_until: string | null;
  aspsp: { name: string; country: string } | null;
}

/** "12.30" | 12.3 → 1230 céntimos (siempre positivo; el signo lo da credit_debit_indicator). */
export function amountToCents(a: Amount | undefined): number | null {
  if (!a || a.amount === undefined || a.amount === null) return null;
  const n = typeof a.amount === "number" ? a.amount : Number(String(a.amount).replace(",", "."));
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null;
}

/** Saldo preferido: disponible, luego contable. */
export function pickBalance(list: ApiBalance[]): { cents: number; currency: string } | null {
  const order = ["ITAV", "CLAV", "XPCD", "ITBD", "CLBD", "OPAV"];
  const sorted = [...list].sort((a, b) => {
    const ia = order.indexOf(a.balance_type ?? ""), ib = order.indexOf(b.balance_type ?? "");
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const b of sorted) {
    const raw = b.balance_amount?.amount;
    const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(",", "."));
    if (Number.isFinite(n)) return { cents: Math.round(n * 100), currency: b.balance_amount?.currency ?? "EUR" };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Cliente                                                             */
/* ------------------------------------------------------------------ */

export class EnableBanking {
  constructor(
    private readonly appId: string,
    private readonly pem: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = ENABLE_BANKING_BASE,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await signJwt(this.appId, this.pem)}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return (res.status === 204 ? {} : await res.json()) as T;
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string; detail?: unknown };
    const detail = data.message || data.error || (typeof data.detail === "string" ? data.detail : "");
    if (res.status === 401) throw new BankError("Enable Banking no acepta la firma: revisa el id de la aplicación y la clave privada.", 401);
    if (res.status === 429) throw new BankError("El banco limita las consultas (PSD2 permite pocas al día sin ti delante). Prueba más tarde.", 429);
    throw new BankError(`Enable Banking respondió ${res.status}${detail ? `: ${detail}` : ""}.`, res.status);
  }

  async aspsps(country: string): Promise<Aspsp[]> {
    const r = await this.request<{ aspsps?: Aspsp[] }>("GET", `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`);
    return (r.aspsps ?? []).filter((a) => !a.psu_types || a.psu_types.includes("personal"));
  }

  async startAuth(o: { aspsp: { name: string; country: string }; redirectUrl: string; state: string; validUntil: string }): Promise<string> {
    const r = await this.request<{ url?: string }>("POST", "/auth", {
      access: { valid_until: o.validUntil },
      aspsp: o.aspsp,
      state: o.state,
      redirect_url: o.redirectUrl,
      psu_type: "personal",
    });
    if (!r.url) throw new BankError("Enable Banking no ha devuelto la dirección del banco.");
    return r.url;
  }

  async createSession(code: string): Promise<SessionResult> {
    const r = await this.request<{
      session_id?: string;
      accounts?: (ApiAccount | string)[];
      access?: { valid_until?: string };
      aspsp?: { name: string; country: string };
    }>("POST", "/sessions", { code });
    if (!r.session_id) throw new BankError("Enable Banking no ha creado la sesión con el banco.");
    return {
      session_id: r.session_id,
      accounts: (r.accounts ?? []).map((a) => (typeof a === "string" ? { uid: a } : a)).filter((a) => a.uid),
      valid_until: r.access?.valid_until ?? null,
      aspsp: r.aspsp ?? null,
    };
  }

  async deleteSession(id: string): Promise<void> {
    await this.request("DELETE", `/sessions/${encodeURIComponent(id)}`).catch(() => {});
  }

  async balances(uid: string): Promise<ApiBalance[]> {
    return (await this.request<{ balances?: ApiBalance[] }>("GET", `/accounts/${encodeURIComponent(uid)}/balances`)).balances ?? [];
  }

  /** Movimientos desde una fecha, recorriendo todas las páginas (con tope). */
  async transactions(uid: string, dateFrom: string, maxPages = 20): Promise<ApiTransaction[]> {
    const out: ApiTransaction[] = [];
    let key: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ date_from: dateFrom });
      if (key) q.set("continuation_key", key);
      const r = await this.request<{ transactions?: ApiTransaction[]; continuation_key?: string | null }>(
        "GET",
        `/accounts/${encodeURIComponent(uid)}/transactions?${q}`,
      );
      out.push(...(r.transactions ?? []));
      if (!r.continuation_key) break;
      key = r.continuation_key;
    }
    return out;
  }
}
