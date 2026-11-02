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
}

export interface ChatResponse {
  message: UiMessage;
  /** IDs del historial creados durante este turno, para animar y deshacer. */
  changeIds: string[];
  preview?: SchedulePreview;
  notice?: string;
}

export interface AuthStatus {
  authenticated: boolean;
  hasCredentials: boolean;
}
export * from "./time";
