import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Ajustes                                                             */
/* ------------------------------------------------------------------ */

export const SettingsSchema = z.object({
  /** Nombre de la columna que hay que leer en la foto del horario. */
  scheduleColumnName: z.string().min(1).default("Angel"),
  timezone: z.string().min(1).default("Europe/Helsinki"),
  /** Calendario de Google donde Marlon escribe. */
  googleCalendarId: z.string().min(1).default("primary"),
  /** Título de los eventos de trabajo creados desde la foto. */
  workEventTitle: z.string().min(1).default("Trabajo"),
  /** Ubicación del trabajo (solo en ajustes, nunca en el código). */
  workLocation: z.string().default(""),
  homeAddress: z.string().default(""),
  universityAddress: z.string().default(""),
  gymAddress: z.string().default(""),
  /** Si es false, la foto del horario solo se envía con la clave de pago. */
  allowFreeTierForSchedulePhoto: z.boolean().default(true),
  /** Si la lectura no tiene incidencias, se guarda sola y se avisa después. */
  autoConfirmCleanSchedule: z.boolean().default(true),
  /** Horas del día que se consideran para buscar huecos. */
  dayStart: z.string().regex(/^\d{2}:\d{2}$/).default("07:00"),
  dayEnd: z.string().regex(/^\d{2}:\d{2}$/).default("22:30"),

  /* ---- Fase 2: sueño y rutina ---- */
  /** Horas de sueño. Regla intocable: nunca menos de 8. */
  sleepHours: z.number().min(8).max(12).default(8),
  /** Desde que te levantas hasta que sales de casa. */
  morningRoutineMin: z.number().int().min(0).max(180).default(45),
  /** Desde que llegas a casa hasta que te acuestas. */
  windDownMin: z.number().int().min(0).max(180).default(30),
  /** Hora de levantarse en días sin compromisos. */
  freeDayWake: z.string().regex(/^\d{2}:\d{2}$/).default("08:30"),
  /** Trayecto estimado cuando no hay ruta calculada (minutos). */
  defaultCommuteMin: z.number().int().min(0).max(180).default(30),
  /** Margen para llegar antes de cada evento (minutos). */
  arrivalMarginMin: z.number().int().min(0).max(60).default(10),

  /* ---- Fase 2: gimnasio ---- */
  gymSessionsMin: z.number().int().min(0).max(7).default(3),
  gymSessionsMax: z.number().int().min(0).max(7).default(4),
  /** Bloque flexible del gimnasio, incluido el trayecto de ida y vuelta. */
  gymBlockMinMin: z.number().int().min(30).max(300).default(80),
  gymBlockMaxMin: z.number().int().min(30).max(300).default(140),
  gymTravelMin: z.number().int().min(0).max(60).default(10),
  gymPreferMorning: z.boolean().default(true),
  /** Desde que te levantas hasta salir al gimnasio. */
  gymMorningPrepMin: z.number().int().min(0).max(120).default(15),
  /** Tras volver del gimnasio, antes de salir de nuevo (ducha, comida). */
  gymAfterMin: z.number().int().min(0).max(120).default(30),

  /* ---- Fase 2: rutas, bici y tiempo ---- */
  cityName: z.string().default("Turku"),
  latitude: z.number().min(-90).max(90).default(60.4518),
  longitude: z.number().min(-180).max(180).default(22.2666),
  /** Meses (1-12) en los que la bici es una opción. Fuera de ellos, nunca. */
  bikeFromMonth: z.number().int().min(1).max(12).default(4),
  bikeToMonth: z.number().int().min(1).max(12).default(10),
  /** Trayecto máximo en bici para proponerla (minutos). */
  bikeMaxMin: z.number().int().min(5).max(90).default(25),

  /* ---- Fase 2: resúmenes ---- */
  morningBriefing: z.boolean().default(true),
  eveningReview: z.boolean().default(true),

  /* ---- Fase 3: voz, avisos y pendientes ---- */
  /** Modo solo texto: sin voz ni sonido de ningún tipo (también en las notificaciones). */
  textOnly: z.boolean().default(false),
  /** Voz de las respuestas: la del navegador (gratis) o la del proveedor (si está configurada). */
  voice: z.enum(["browser", "provider"]).default("browser"),
  /** Avisar de la hora de salida (minutos antes). 0 = no avisar. */
  leaveReminderMin: z.number().int().min(0).max(60).default(10),
  /** Minutos antes de acostarse para el repaso de la noche. */
  eveningReviewLeadMin: z.number().int().min(0).max(180).default(45),
  /** Días de antelación para avisar de un cumpleaños. */
  birthdayNoticeDays: z.number().int().min(0).max(60).default(7),
  /** Insistir con los pendientes del día (de forma gradual). */
  pendingNudges: z.boolean().default(true),

  /* ---- Fase 4: dinero ---- */
  /** Víspera de festivo: "probable" (el 50 % sube también la base) o "minimum" (solo el suplemento). */
  payEveMode: z.enum(["probable", "minimum"]).default("probable"),
  /**
   * Turno que cruza la medianoche hacia un domingo o festivo. "ask" = no se supone nada:
   * esas horas quedan sin calcular hasta que se elija regla.
   */
  payMidnightRule: z.enum(["ask", "calendar_day", "shift_start"]).default("ask"),
  /** Permitir datos económicos por la capa gratuita sin preguntar cada vez. */
  financialFreeTierAlways: z.boolean().default(false),
  /** Coste de un café hecho en casa (céntimos), para las comparaciones. */
  homeCoffeeCents: z.number().int().min(0).max(1000).default(35),
  /** Precio de un termo, que se amortiza en las comparaciones (céntimos). */
  thermosCents: z.number().int().min(0).max(20000).default(2500),

  /* ---- Fase 4: comida ---- */
  /** Presupuesto semanal de comida (céntimos). 0 = sin presupuesto. */
  foodWeeklyBudgetCents: z.number().int().min(0).max(100000).default(4000),
  /** Peso aproximado para el objetivo de proteína (kg). 0 = no calcular. */
  bodyWeightKg: z.number().min(0).max(300).default(0),
  /** Gramos de proteína por kg al día para ganar músculo. */
  proteinPerKg: z.number().min(0.8).max(2.5).default(1.6),
  /** Día preferido para cocinar (0 = domingo). */
  cookingWeekday: z.number().int().min(0).max(6).default(0),
  /** Ideas de batch cooking a la semana (1 o 2). */
  cookingVideosPerWeek: z.number().int().min(0).max(2).default(2),

  /* ---- Fase 5: bienestar y lectura ---- */
  /** Bloque de estudio por defecto (minutos). */
  studyBlockMin: z.number().int().min(15).max(180).default(50),
  /** Descanso proporcional al bloque (0.2 = 10 min por cada 50). */
  studyBreakRatio: z.number().min(0.1).max(0.5).default(0.2),
  /** Preguntar por el libro al acabar un trayecto en bus. */
  readingPrompts: z.boolean().default(true),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/* ------------------------------------------------------------------ */
/* Calendario                                                          */
/* ------------------------------------------------------------------ */

export const EventKindSchema = z.enum(["work_planned", "university", "gym", "marlon", "manual"]);
export type EventKind = z.infer<typeof EventKindSchema>;

export interface CalendarEvent {
  id: string;
  title: string;
  /** Instantes en ISO UTC. */
  start: string;
  end: string;
  location?: string | null;
  description?: string | null;
  kind: EventKind;
  allDay?: boolean;
  /** Clave interna para no duplicar eventos (p. ej. "work:2026-11-02"). */
  marlonKey?: string | null;
}

/** Evento de vista previa (aún no guardado). */
export interface PreviewEvent {
  key: string;
  title: string;
  start: string;
  end: string;
  status: "new" | "changed" | "unchanged" | "removed" | "issue";
}

export interface ScheduleIssue {
  row: number;
  kind:
    | "unreadable_date"
    | "weekday_mismatch"
    | "unreadable_time"
    | "incomplete"
    | "hours_mismatch"
    | "duplicate_date";
  message: string;
  date?: string;
}

export interface SchedulePreview {
  uploadId: string;
  status: "pending" | "confirmed" | "discarded";
  shifts: { date: string; start: string; end: string; endsNextDay: boolean; hours: number }[];
  daysOff: string[];
  issues: ScheduleIssue[];
  events: PreviewEvent[];
}

/* ------------------------------------------------------------------ */
/* Historial                                                           */
/* ------------------------------------------------------------------ */

export type ChangeAction = "create" | "move" | "update" | "delete";

export interface ChangeLogEntry {
  id: string;
  createdAt: string;
  actor: "marlon" | "user";
  action: ChangeAction;
  eventId: string | null;
  summary: string;
  groupId: string | null;
  undoneAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

export interface ChatImage {
  mime: "image/jpeg" | "image/png" | "image/webp";
  /** Base64 sin prefijo data:. */
  data: string;
}

export const ChatRequestSchema = z.object({
  text: z.string().max(8000).default(""),
  /** Nota de voz en WAV (base64). Unos 90 s como máximo. */
  audio: z
    .object({
      mime: z.literal("audio/wav"),
      data: z.string().max(4_000_000),
    })
    .optional(),
  images: z
    .array(
      z.object({
        mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
        data: z.string().max(8_000_000),
      }),
    )
    .max(4)
    .default([]),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  quickReplies?: string[];
  hasImages?: boolean;
  /** El mensaje del usuario llegó como nota de voz (text es la transcripción). */
  fromVoice?: boolean;
  /** Idioma de la respuesta, para elegir la voz. */
  lang?: "es" | "en";
}

export interface ChatResponse {
  message: UiMessage;
  /** IDs del historial creados durante este turno, para animar y deshacer. */
  changeIds: string[];
  preview?: SchedulePreview;
  notice?: string;
  /** Transcripción de la nota de voz, si la hubo. */
  transcript?: string;
  /** Sesión de bienestar que hay que abrir (temporizador, meditación, estiramientos). */
  session?: WellbeingSession;
}

/* ------------------------------------------------------------------ */
/* Pendientes                                                          */
/* ------------------------------------------------------------------ */

export const PendingKindSchema = z.enum(["reminder", "task", "plan", "birthday"]);
export type PendingKind = z.infer<typeof PendingKindSchema>;

export interface Pending {
  id: string;
  kind: PendingKind;
  title: string;
  /** Persona relacionada ("contestar a Mateo"). */
  person: string | null;
  notes: string | null;
  /** Ámbito: trabajo, uni o personal. */
  area: "work" | "uni" | "personal";
  /** Fecha local YYYY-MM-DD (en cumpleaños, la del próximo). */
  dueDate: string | null;
  /** Hora local HH:MM opcional. */
  dueTime: string | null;
  /** Para planes: corto o largo plazo. */
  horizon: "short" | "long" | null;
  status: "open" | "done";
  createdAt: string;
  doneAt: string | null;
}

export interface AuthStatus {
  authenticated: boolean;
  hasCredentials: boolean;
}
export * from "./time";

/* ------------------------------------------------------------------ */
/* Dinero                                                              */
/* ------------------------------------------------------------------ */

/** Reglas de pago (importes brutos en céntimos). Editables con fecha de vigencia. */
export const PayRulesSchema = z.object({
  baseCents: z.number().int().min(0),
  /** Suplemento de tarde y desde qué hora. */
  eveningSupplementCents: z.number().int().min(0),
  eveningFrom: z.string().regex(/^\d{2}:\d{2}$/),
  /** Suplemento de noche (de 00:00 a nightTo). */
  nightSupplementCents: z.number().int().min(0),
  nightTo: z.string().regex(/^\d{2}:\d{2}$/),
  /** Domingos y festivos: multiplicador sobre base y suplementos (2 = +100 %). */
  sundayHolidayMultiplier: z.number().min(1).max(4),
  /** ¿Confirmado que el suplemento de noche también se dobla en domingo? */
  sundayNightConfirmed: z.boolean(),
  /** Víspera de festivo: desde qué hora y cuánto (1.5 = +50 %). */
  eveFrom: z.string().regex(/^\d{2}:\d{2}$/),
  eveMultiplier: z.number().min(1).max(4),
});
export type PayRules = z.infer<typeof PayRulesSchema>;

export interface PayRuleSet {
  id: string;
  validFrom: string; // YYYY-MM-DD
  validTo: string | null;
  rules: PayRules;
  note: string | null;
}

export const ExpenseCategorySchema = z.enum([
  "groceries",
  "eating_out",
  "coffee",
  "transport",
  "housing",
  "utilities",
  "health",
  "education",
  "leisure",
  "shopping",
  "subscriptions",
  "other",
]);
export type ExpenseCategory = z.infer<typeof ExpenseCategorySchema>;

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  groceries: "Súper",
  eating_out: "Comer fuera",
  coffee: "Cafés",
  transport: "Transporte",
  housing: "Vivienda",
  utilities: "Suministros",
  health: "Salud",
  education: "Estudios",
  leisure: "Ocio",
  shopping: "Compras",
  subscriptions: "Suscripciones",
  other: "Otros",
};

export interface Expense {
  id: string;
  date: string;
  amountCents: number;
  merchant: string | null;
  category: ExpenseCategory;
  note: string | null;
  source: "text" | "voice" | "receipt" | "bank";
  createdAt: string;
}

export interface BudgetItem {
  id: string;
  kind: "income" | "fixed";
  name: string;
  amountCents: number;
  /** Necesidad (vivienda, suministros…) o deseo, para la regla 50/30/20. */
  bucket: "needs" | "wants" | "savings" | null;
}

/** Formato "1 234,56 €". */
export function formatEuros(cents: number, decimals = 2): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  }).format(cents / 100);
}

/* ------------------------------------------------------------------ */
/* Bienestar: temporizadores, meditación y estiramientos               */
/* ------------------------------------------------------------------ */

export interface SessionPhase {
  label: string;
  seconds: number;
  kind: "work" | "rest" | "step";
  /** Texto guiado (meditación, estiramientos) que se lee en voz alta si hay voz. */
  text?: string;
}

export interface WellbeingSession {
  id: string;
  kind: "timer" | "meditation" | "stretch";
  title: string;
  phases: SessionPhase[];
  /** Instante (ISO) en que empezó la fase 0, descontando pausas. */
  startedAt: string;
  status: "running" | "paused" | "done" | "cancelled";
  /** Si está en pausa, segundos ya transcurridos. */
  elapsedAtPause: number | null;
}

/** Fase actual y segundos que le quedan. null si ya ha terminado. */
export function sessionPosition(
  phases: SessionPhase[],
  elapsedSeconds: number,
): { index: number; remaining: number; phaseElapsed: number } | null {
  let t = elapsedSeconds;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i]!;
    if (t < p.seconds) return { index: i, remaining: p.seconds - t, phaseElapsed: t };
    t -= p.seconds;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Lectura y memoria                                                   */
/* ------------------------------------------------------------------ */

export interface Book {
  id: string;
  title: string;
  author: string | null;
  genre: string | null;
  status: "reading" | "finished" | "abandoned";
  percent: number;
  startedAt: string;
  finishedAt: string | null;
  rating: number | null;
  opinion: string | null;
}

export interface Memory {
  id: string;
  content: string;
  category: "preference" | "routine" | "person" | "health" | "reading" | "other";
  createdAt: string;
  updatedAt: string;
}
