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

export interface CalendarBackend {
  readonly kind: "google" | "local";
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
      "Google ha rechazado el acceso al calendario (refresh token caducado o revocado). Vuelve a ejecutar `pnpm google:auth` y actualiza el secreto GOOGLE_REFRESH_TOKEN.",
    );
    this.name = "GoogleAuthError";
  }
}

/* ------------------------------------------------------------------ */
/* Backend local: sin Google, el calendario vive solo en D1.            */
/* Sirve para desarrollar y para probar la app sin credenciales.       */
/* ------------------------------------------------------------------ */

export class LocalBackend implements CalendarBackend {
  readonly kind = "local" as const;
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

let tokenCache: { token: string; expiresAt: number } | null = null;

export class GoogleBackend implements CalendarBackend {
  readonly kind = "google" as const;

  constructor(
    private readonly env: Env,
    private readonly calendarId: string,
    private readonly tz: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(force = false): Promise<string> {
    if (!force && tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
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
    tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
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

export function createBackend(env: Env, calendarId: string, tz: string): CalendarBackend {
  if (env.GOOGLE_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return new GoogleBackend(env, calendarId, tz);
  }
  return new LocalBackend();
}
