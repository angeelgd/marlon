import type {
  AuthStatus,
  CalendarEvent,
  ChangeLogEntry,
  ChatRequest,
  ChatResponse,
  Pending,
  SchedulePreview,
  Settings,
  UiMessage,
} from "@marlon/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (res.status === 401 && !path.startsWith("/auth")) onUnauthorized?.();
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Error ${res.status}`, res.status, data.code);
  return data;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  authStatus: () => request<AuthStatus>("/auth/status"),
  registerOptions: (setupToken: string) => post<Record<string, unknown>>("/auth/register/options", { setupToken }),
  registerVerify: (response: unknown) => post<{ ok: true }>("/auth/register/verify", response),
  loginOptions: () => post<Record<string, unknown>>("/auth/login/options"),
  loginVerify: (response: unknown) => post<{ ok: true }>("/auth/login/verify", response),
  logout: () => post<{ ok: true }>("/auth/logout"),

  messages: () => request<{ messages: UiMessage[] }>("/messages"),
  chat: (body: ChatRequest) => post<ChatResponse>("/chat", body),

  events: (from: string, to: string) =>
    request<{ events: CalendarEvent[]; backend: "google" | "local" }>(
      `/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  sync: () => post<{ updated: number; skipped: boolean }>("/sync"),

  history: () => request<{ entries: ChangeLogEntry[] }>("/history"),
  undo: (id: string) => post<{ undone: number }>(`/history/${encodeURIComponent(id)}/undo`),

  confirmSchedule: (id: string) => post<{ changeIds: string[] }>(`/schedule/${encodeURIComponent(id)}/confirm`),
  discardSchedule: (id: string) => post<{ ok: true }>(`/schedule/${encodeURIComponent(id)}/discard`),
  schedule: (id: string) => request<SchedulePreview>(`/schedule/${encodeURIComponent(id)}`),

  syncUniversity: () =>
    post<{ created: number; changed: number; removed: number; unchanged: number; conflicts: unknown[] }>("/university/sync"),
  replanGym: () =>
    post<{ sessions: { start: string; end: string }[]; created: number; changed: number; removed: number; belowTarget: boolean }>(
      "/gym/replan",
    ),

  pushKey: () => request<{ publicKey: string }>("/push/key"),
  pushSubscribe: (sub: PushSubscriptionJSON) => post<{ ok: true }>("/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => post<{ ok: true }>("/push/unsubscribe", { endpoint }),
  pushTest: () => post<{ sent: number; failed: number }>("/push/test"),

  pendings: (done = false) => request<{ pendings: Pending[] }>(`/pendings${done ? "?done=1" : ""}`),
  closePending: (id: string) => post<{ pending: Pending }>(`/pendings/${encodeURIComponent(id)}/close`),
  reopenPending: (id: string) => post<{ ok: true }>(`/pendings/${encodeURIComponent(id)}/reopen`),
  deletePending: (id: string) =>
    request<{ ok: true }>(`/pendings/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" } }),

  settings: () => request<{ settings: Settings; calendarBackend: "google" | "local" }>("/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings }>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
};
