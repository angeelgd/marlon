import type { EventKind } from "@marlon/shared";
import type { Env } from "../env";
import { newId } from "../lib/ids";

/** Evento tal como lo maneja Marlon (instantes en ISO UTC). */
export interface EventInput {
  title: string;
  start: string;
  end: string;
  location?: string | null;
  description?: string | null;
  kind: EventKind;
  /** Clave estable para encontrar el evento sin duplicarlo (p. ej. "work:2026-11-02"). */
  marlonKey?: string | null;
}

export interface RemoteEvent extends EventInput {
  id: string;
  etag?: string | null;
  allDay?: boolean;
  cancelled?: boolean;
}

export interface ChangesPage {
  events: RemoteEvent[];
  nextSyncToken: string | null;
}

export type BatchOp =
  | { op: "insert"; ev: EventInput }
  | { op: "patch"; id: string; ev: Partial<EventInput> }
  | { op: "remove"; id: string };

export type BatchResult = { ok: true; event: RemoteEvent | null } | { ok: false; error: string };

export interface CalendarBackend {
  readonly kind: "google" | "local";
  /** Varias operaciones de una vez (en Google, una sola subpetición por cada 50). */
  batch(ops: BatchOp[]): Promise<BatchResult[]>;
  insert(ev: EventInput): Promise<RemoteEvent>;
  patch(id: string, ev: Partial<EventInput>): Promise<RemoteEvent>;
  remove(id: string): Promise<void>;
  /** Cambios desde el último syncToken (o todo desde timeMin si no hay token). */
  listChanges(syncToken: string | null, timeMin: string): Promise<ChangesPage>;
}

export class SyncTokenExpiredError extends Error {}
export class GoogleAuthError extends Error {
  constructor() {
    super(
      "Google ha rechazado el acceso al calendario (el permiso ha caducado o se ha revocado). Vuelve a conectarlo en Ajustes > Conexiones.",
    );
    this.name = "GoogleAuthError";
  }
}

/* ------------------------------------------------------------------ */
/* Backend local: sin Google, el calendario vive solo en D1.            */
/* Sirve para desarrollar y para probar la app sin credenciales.       */
/* ------------------------------------------------------------------ */

/** Ejecuta un lote operación a operación (backend local y respaldo). */
async function sequentialBatch(b: CalendarBackend, ops: BatchOp[]): Promise<BatchResult[]> {
  const out: BatchResult[] = [];
  for (const o of ops) {
    try {
      if (o.op === "insert") out.push({ ok: true, event: await b.insert(o.ev) });
      else if (o.op === "patch") out.push({ ok: true, event: await b.patch(o.id, o.ev) });
      else {
        await b.remove(o.id);
        out.push({ ok: true, event: null });
      }
    } catch (err) {
      out.push({ ok: false, error: (err as Error).message });
    }
  }
  return out;
}

export class LocalBackend implements CalendarBackend {
  readonly kind = "local" as const;
  batch(ops: BatchOp[]): Promise<BatchResult[]> {
    return sequentialBatch(this, ops);
  }
  async insert(ev: EventInput): Promise<RemoteEvent> {
    return { ...ev, id: newId("local") };
  }
  async patch(id: string, ev: Partial<EventInput>): Promise<RemoteEvent> {
    return { title: "", start: "", end: "", kind: "manual", ...ev, id };
  }
  async remove(): Promise<void> {}
  async listChanges(): Promise<ChangesPage> {
    return { events: [], nextSyncToken: null };
  }
}

/* ------------------------------------------------------------------ */
/* Google Calendar (REST v3, sin SDK)                                  */
/* ------------------------------------------------------------------ */

interface GEvent {
  id: string;
  status?: string;
  etag?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
}

let tokenCache: { token: string; expiresAt: number; refresh: string } | null = null;

export class GoogleBackend implements CalendarBackend {
  readonly kind = "google" as const;

  constructor(
    private readonly env: Env,
    private readonly calendarId: string,
    private readonly tz: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(force = false): Promise<string> {
    const refresh = this.env.GOOGLE_REFRESH_TOKEN ?? "";
    if (!force && tokenCache && tokenCache.refresh === refresh && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
    const res = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: this.env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: this.env.GOOGLE_REFRESH_TOKEN ?? "",
        grant_type: "refresh_token",
      }),
    });
    const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !data.access_token) {
      if (data.error === "invalid_grant" || res.status === 400 || res.status === 401) throw new GoogleAuthError();
      throw new Error(`Error al obtener el token de Google (${res.status}).`);
    }
    tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000, refresh };
    return data.access_token;
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}${path}`,
    );
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const res = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 410) throw new SyncTokenExpiredError();
      if (method === "DELETE" && (res.status === 404 || res.status === 410 || res.status === 204)) return undefined as T;
      if (!res.ok) throw new Error(`Google Calendar respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return (res.status === 204 ? undefined : await res.json()) as T;
    }
    throw new GoogleAuthError();
  }

  private toGoogle(ev: Partial<EventInput>): Partial<GEvent> {
    const out: Partial<GEvent> = {};
    if (ev.title !== undefined) out.summary = ev.title;
    if (ev.location !== undefined) out.location = ev.location ?? "";
    if (ev.description !== undefined) out.description = ev.description ?? "";
    if (ev.start !== undefined) out.start = { dateTime: ev.start, timeZone: this.tz };
    if (ev.end !== undefined) out.end = { dateTime: ev.end, timeZone: this.tz };
    if (ev.kind !== undefined || ev.marlonKey !== undefined) {
      const priv: Record<string, string> = {};
      if (ev.kind !== undefined) priv.marlonKind = ev.kind;
      if (ev.marlonKey) priv.marlonKey = ev.marlonKey;
      out.extendedProperties = { private: priv };
    }
    return out;
  }

  fromGoogle(g: GEvent): RemoteEvent {
    const allDay = Boolean(g.start?.date && !g.start?.dateTime);
    const start = g.start?.dateTime ?? (g.start?.date ? `${g.start.date}T00:00:00` : "");
    const end = g.end?.dateTime ?? (g.end?.date ? `${g.end.date}T00:00:00` : start);
    const priv = g.extendedProperties?.private ?? {};
    return {
      id: g.id,
      etag: g.etag ?? null,
      title: g.summary ?? "(sin título)",
      start,
      end,
      allDay,
      location: g.location ?? null,
      description: g.description ?? null,
      kind: (priv.marlonKind as EventInput["kind"]) ?? "manual",
      marlonKey: priv.marlonKey ?? null,
      cancelled: g.status === "cancelled",
    };
  }

  /**
   * Petición batch de Google Calendar (multipart/mixed, máx. 50 por lote).
   * https://developers.google.com/calendar/api/guides/batch
   */
  async batch(ops: BatchOp[]): Promise<BatchResult[]> {
    const out: BatchResult[] = [];
    for (let i = 0; i < ops.length; i += 50) {
      out.push(...(await this.batchChunk(ops.slice(i, i + 50))));
    }
    return out;
  }

  private async batchChunk(ops: BatchOp[]): Promise<BatchResult[]> {
    if (ops.length === 0) return [];
    const boundary = `batch_${crypto.randomUUID().replace(/-/g, "")}`;
    const base = `/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`;
    const parts = ops.map((o, i) => {
      let line: string;
      let body = "";
      if (o.op === "insert") {
        line = `POST ${base}`;
        body = JSON.stringify(this.toGoogle(o.ev));
      } else if (o.op === "patch") {
        line = `PATCH ${base}/${encodeURIComponent(o.id)}`;
        body = JSON.stringify(this.toGoogle(o.ev));
      } else {
        line = `DELETE ${base}/${encodeURIComponent(o.id)}`;
      }
      return [
        `--${boundary}`,
        "Content-Type: application/http",
        `Content-ID: <item${i}>`,
        "",
        `${line} HTTP/1.1`,
        ...(body ? ["Content-Type: application/json", "", body] : [""]),
      ].join("\r\n");
    });
    const payload = `${parts.join("\r\n")}\r\n--${boundary}--`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const res = await this.fetchImpl("https://www.googleapis.com/batch/calendar/v3", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": `multipart/mixed; boundary=${boundary}` },
        body: payload,
      });
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) throw new Error(`Google Calendar (batch) respondió ${res.status}.`);
      const parsed = parseBatchResponse(res.headers.get("content-type") ?? "", await res.text());
      return ops.map((o, i) => {
        const r = parsed.get(i);
        if (!r) return { ok: false, error: "Sin respuesta en el lote." };
        const gone = o.op === "remove" && (r.status === 404 || r.status === 410);
        if ((r.status < 200 || r.status >= 300) && !gone) {
          return { ok: false, error: `HTTP ${r.status}: ${r.body.slice(0, 200)}` };
        }
        if (o.op === "remove" || !r.body.trim()) return { ok: true, event: null };
        try {
          return { ok: true, event: this.fromGoogle(JSON.parse(r.body) as GEvent) };
        } catch {
          return { ok: false, error: "Respuesta del lote ilegible." };
        }
      });
    }
    throw new GoogleAuthError();
  }

  async insert(ev: EventInput): Promise<RemoteEvent> {
    const g = await this.request<GEvent>("POST", "/events", this.toGoogle(ev));
    return this.fromGoogle(g);
  }

  async patch(id: string, ev: Partial<EventInput>): Promise<RemoteEvent> {
    const g = await this.request<GEvent>("PATCH", `/events/${encodeURIComponent(id)}`, this.toGoogle(ev));
    return this.fromGoogle(g);
  }

  async remove(id: string): Promise<void> {
    await this.request("DELETE", `/events/${encodeURIComponent(id)}`);
  }

  async listChanges(syncToken: string | null, timeMin: string): Promise<ChangesPage> {
    const events: RemoteEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    do {
      const query: Record<string, string> = { singleEvents: "true", maxResults: "250", showDeleted: "true" };
      if (syncToken) query.syncToken = syncToken;
      else query.timeMin = timeMin;
      if (pageToken) query.pageToken = pageToken;
      const page = await this.request<{ items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
        "GET",
        "/events",
        undefined,
        query,
      );
      for (const g of page.items ?? []) events.push(this.fromGoogle(g));
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
    return { events, nextSyncToken };
  }
}

/** Lee una respuesta multipart/mixed de la API batch. Devuelve status y cuerpo por índice. */
export function parseBatchResponse(contentType: string, text: string): Map<number, { status: number; body: string }> {
  const m = /boundary="?([^";]+)"?/i.exec(contentType);
  const out = new Map<number, { status: number; body: string }>();
  if (!m) return out;
  const chunks = text.split(`--${m[1]}`);
  chunks.forEach((chunk, order) => {
    if (!chunk.trim() || chunk.trim() === "--") return;
    const idMatch = /Content-ID:\s*<?response-item(\d+)>?/i.exec(chunk);
    const statusMatch = /HTTP\/1\.1\s+(\d{3})/.exec(chunk);
    if (!statusMatch) return;
    const afterStatus = chunk.slice(statusMatch.index);
    const sep = afterStatus.search(/\r?\n\r?\n/);
    const body = sep === -1 ? "" : afterStatus.slice(sep).trim();
    const index = idMatch ? Number(idMatch[1]) : order - 1;
    out.set(index, { status: Number(statusMatch[1]), body });
  });
  return out;
}

export function createBackend(env: Env, calendarId: string, tz: string): CalendarBackend {
  if (env.GOOGLE_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return new GoogleBackend(env, calendarId, tz);
  }
  return new LocalBackend();
}
