import type {
  AuthStatus,
  CalendarEvent,
  ChangeLogEntry,
  ChatRequest,
  ChatResponse,
  Pending,
  BudgetItem,
  Expense,
  ExpenseCategory,
  PayRuleSet,
  Book,
  Memory,
  WellbeingSession,
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
  connections: () => request<Connections>("/connections"),
  saveConnection: (
    name: "google-client" | "youtube" | "maps" | "enable-banking",
    body: { clientId?: string; clientSecret?: string; key?: string; appId?: string; privateKey?: string },
  ) =>
    request<{ ok: true }>(`/connections/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteConnection: (name: "google" | "google-client" | "youtube" | "maps" | "enable-banking") =>
    request<{ ok: true }>(`/connections/${name}`, { method: "DELETE", headers: { "content-type": "application/json" } }),
  bank: () => request<BankStatus>("/bank"),
  bankAspsps: (country = "FI") => request<{ aspsps: Aspsp[] }>(`/bank/aspsps?country=${country}`),
  bankConnect: (a: Aspsp) => post<{ url: string }>("/bank/connect", a),
  bankSync: () => post<{ accounts: number; newTransactions: number; newExpenses: number; matched: number; errors: string[] }>("/bank/sync"),
  bankTransactions: (from: string, to: string) => request<{ transactions: BankTx[] }>(`/bank/transactions?from=${from}&to=${to}`),
  bankDisconnect: (id: string) =>
    request<{ ok: true }>(`/bank/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" } }),
  recategorizeExpense: (id: string, category: string) =>
    request<{ updated: number }>(`/expenses/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ category }) }),
  universityLink: () => request<UniversityLink>("/university/link"),
  saveUniversityLink: (url: string) =>
    request<UniversityLink & { sync: { created: number; changed: number; removed: number; unchanged: number; conflicts: unknown[] } }>(
      "/university/link",
      { method: "PUT", body: JSON.stringify({ url }) },
    ),
  deleteUniversityLink: () =>
    request<UniversityLink>("/university/link", { method: "DELETE", headers: { "content-type": "application/json" } }),
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

  money: (month?: string) => request<MoneyData>(`/money${month ? `?month=${month}` : ""}`),
  addExpense: (e: { date: string; amountCents: number; category: ExpenseCategory; merchant?: string | null }) =>
    post<{ expense: Expense }>("/expenses", e),
  deleteExpense: (id: string) =>
    request<{ ok: true }>(`/expenses/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" } }),
  setBudget: (b: { kind: "income" | "fixed"; name: string; amountCents: number; bucket?: "needs" | "wants" | "savings" | null }) =>
    request<{ item: BudgetItem }>("/budget", { method: "PUT", body: JSON.stringify(b) }),
  deleteBudget: (id: string) =>
    request<{ ok: true }>(`/budget/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" } }),
  setActualShift: (date: string, body: { start?: string; end?: string; dayOff?: boolean }) =>
    request<unknown>(`/actual-shifts/${date}`, { method: "PUT", body: JSON.stringify(body) }),
  clearActualShift: (date: string) =>
    request<{ ok: true }>(`/actual-shifts/${date}`, { method: "DELETE", headers: { "content-type": "application/json" } }),
  savePayRules: (set: Omit<PayRuleSet, "id"> & { id?: string }) =>
    request<{ ruleSet: PayRuleSet }>("/pay-rules", { method: "PUT", body: JSON.stringify(set) }),
  deletePayRules: (id: string) =>
    request<{ ok: true }>(`/pay-rules/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" } }),

  food: () => request<FoodData>("/food"),
  toggleShopping: (week: string, name: string, checked: boolean) => post<{ ok: true }>("/food/shopping/toggle", { week, name, checked }),

  session: () => request<{ session: WellbeingSession | null }>("/session"),
  sessionAction: (id: string, action: "pause" | "resume" | "cancel") =>
    post<{ session?: WellbeingSession }>(`/session/${encodeURIComponent(id)}/${action}`),
  startSession: (kind: "meditation" | "stretch", opt: number | "post_gym" | "desk") =>
    post<{ session: WellbeingSession }>("/session/start", kind === "meditation" ? { kind, minutes: opt } : { kind, routine: opt }),
  reading: () => request<ReadingData>("/reading"),
  memories: () => request<{ memories: Memory[] }>("/memories"),
  addMemory: (content: string, category: Memory["category"]) => post<unknown>("/memories", { content, category }),
  updateMemory: (id: string, content: string) =>
    request<{ ok: true }>(`/memories/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ content }) }),
  deleteMemory: (id: string) =>
    request<{ ok: true }>(`/memories/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "content-type": "application/json" } }),
  knowledge: () => request<{ docs: { id: string; title: string; sources: string[] }[] }>("/knowledge"),

  settings: () => request<{ settings: Settings; calendarBackend: "google" | "local" }>("/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings }>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
};

export type CredentialSource = "secret" | "app" | null;
export interface Connections {
  google: { clientSource: CredentialSource; connected: boolean; tokenSource: CredentialSource; redirectUri: string };
  youtube: { source: CredentialSource };
  maps: { source: CredentialSource };
  bank: { source: CredentialSource; redirectUri: string };
}

export interface Aspsp {
  name: string;
  country: string;
  logo?: string | null;
  maximumConsentSeconds?: number | null;
}

export interface BankStatus {
  configured: boolean;
  links: {
    id: string;
    bank: string;
    validUntil: string | null;
    status: "active" | "expired" | "revoked";
    lastSyncAt: string | null;
    lastError: string | null;
    accounts: { uid: string; name: string | null; iban: string | null; currency: string | null; balanceCents: number | null; balanceAt: string | null }[];
  }[];
}

export interface BankTx {
  id: string;
  date: string;
  amountCents: number;
  counterparty: string | null;
  description: string | null;
  status: "booked" | "pending";
  kind: "normal" | "own_transfer";
  expenseId: string | null;
}

export interface UniversityLink {
  configured: boolean;
  /** "secret": fijado en Cloudflare; "app": guardado desde Ajustes. */
  source: "secret" | "app" | null;
  host: string | null;
}

export interface DayComparison {
  date: string;
  planned: string | null;
  actual: string | null;
  plannedEuros: number | null;
  actualEuros: number | null;
  assumed: boolean;
  dayName: string | null;
  flags: string[];
}

export interface MoneyData {
  month: string;
  pay: {
    plannedCents: number;
    actualCents: number;
    differenceCents: number;
    plannedHours: number;
    actualHours: number;
    days: DayComparison[];
    differingDays: DayComparison[];
    unresolved: { date: string; calendarDayEuros: number; shiftStartEuros: number }[];
    toConfirm: { date: string; reason: string }[];
    missingRules: string[];
    disclaimer: string;
  };
  summary: {
    incomeCents: number;
    incomeSource: "budget" | "pay_estimate" | "none";
    fixedCents: number;
    variableCents: number;
    byCategory: { category: ExpenseCategory; cents: number; count: number; previousCents: number }[];
    rule503020: {
      needsCents: number;
      wantsCents: number;
      needsPct: number | null;
      wantsPct: number | null;
      savingsTargetCents: number;
      projectedLeftCents: number;
      suggestedSavingsCents: number;
    };
    alerts: string[];
    comparisons: string[];
    disclaimer: string;
  };
  expenses: Expense[];
  budget: BudgetItem[];
  ruleSets: PayRuleSet[];
  options: { eveMode: "probable" | "minimum"; midnightRule: "ask" | "calendar_day" | "shift_start" };
}

export interface ShoppingGroup {
  category: string;
  label: string;
  items: { name: string; quantity: number | null; unit: string | null; recipes: string[]; checked?: boolean }[];
}

export interface FoodData {
  plan: {
    weekStart: string;
    plan: {
      days: { date: string; lunch: { recipe: string; fromFreezer: boolean } | null; dinner: { recipe: string; fromFreezer: boolean } | null; note: string | null }[];
      cookDate: string;
      recipes: { id: string; title: string; url: string }[];
      nutrition: { protein_per_day_g: number | null; protein_target_g: number | null; notes: string[]; warnings: string[]; disclaimer: string };
      budget: { message: string | null };
    };
    shopping: ShoppingGroup[];
  } | null;
  recipes: { videoId: string; url: string; title: string; channel: string | null; source: string; recipe: { highlights: string; servings: number } }[];
}

export interface ReadingData {
  current: Book | null;
  estimate: { pacePerTrip: number | null; remainingMinutes: number | null; remainingTrips: number | null; finishDate: string | null } | null;
  books: Book[];
}
