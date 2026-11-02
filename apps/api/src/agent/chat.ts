import type { ChatRequest, ChatResponse, UiMessage } from "@marlon/shared";
import { createBackend, GoogleAuthError } from "../calendar/backend";
import { CalendarService } from "../calendar/service";
import { syncCalendar } from "../calendar/sync";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { newId, nowIso } from "../lib/ids";
import { LlmError, type LlmMessage } from "../llm/provider";
import { getLlm } from "../llm/router";
import { runAgent, trimHistory } from "./loop";
import { detectLanguage, polish } from "./style";
import { buildSystemPrompt } from "./system-prompt";
import { PHASE1_TOOLS } from "./tools";
import { PHASE2_TOOLS } from "./tools/planning";
import { PENDING_TOOLS } from "./tools/pendings";
import { transcribe } from "../llm/transcribe";
import type { ToolContext } from "./tools/types";

const HISTORY_LIMIT = 30;

export async function calendarFor(env: Env) {
  const settings = await getSettings(env.DB);
  const backend = createBackend(env, settings.googleCalendarId, settings.timezone);
  return { settings, calendar: new CalendarService(env.DB, backend, settings.timezone, settings.googleCalendarId) };
}

async function loadHistory(db: D1Database): Promise<LlmMessage[]> {
  const { results } = await db
    .prepare(`SELECT content_json FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .bind(HISTORY_LIMIT)
    .all<{ content_json: string }>();
  return trimHistory(results.reverse().map((r) => JSON.parse(r.content_json) as LlmMessage), HISTORY_LIMIT);
}

async function saveMessages(db: D1Database, items: { msg: LlmMessage; ui?: UiMessage }[]): Promise<void> {
  if (!items.length) return;
  const base = Date.now();
  await db.batch(
    items.map(({ msg, ui }, i) =>
      db
        .prepare(`INSERT INTO messages (id, role, content_json, ui_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(ui?.id ?? newId("msg"), msg.role, JSON.stringify(msg), ui ? JSON.stringify(ui) : null, new Date(base + i).toISOString()),
    ),
  );
}

export async function listUiMessages(db: D1Database, limit = 100): Promise<UiMessage[]> {
  const { results } = await db
    .prepare(`SELECT ui_json FROM messages WHERE ui_json IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .bind(limit)
    .all<{ ui_json: string }>();
  return results.reverse().map((r) => JSON.parse(r.ui_json) as UiMessage);
}

export async function handleChat(env: Env, req: ChatRequest, now = Date.now()): Promise<ChatResponse> {
  const { settings, calendar } = await calendarFor(env);
  let notice: string | undefined;

  try {
    await syncCalendar(env.DB, calendar);
  } catch (err) {
    if (err instanceof GoogleAuthError) notice = err.message;
    else console.warn("sync falló", err);
  }

  // Las imágenes se guardan aparte; el modelo de chat solo ve una referencia.
  const imageIds: string[] = [];
  for (const img of req.images) {
    const id = newId("img");
    await env.DB.prepare(`INSERT INTO pending_images (id, mime, data, created_at) VALUES (?, ?, ?, ?)`)
      .bind(id, img.mime, img.data, nowIso())
      .run();
    imageIds.push(id);
  }
  const refs = imageIds.map((_, i) => `[imagen ${i}] adjunta`).join("\n");

  // Nota de voz: primero se transcribe y luego se trata como texto.
  let transcript: string | undefined;
  if (req.audio) {
    try {
      transcript = await transcribe(getLlm(env), req.audio.data);
    } catch (err) {
      console.error("transcripción falló", err);
      const msg = err instanceof LlmError ? err.message : "No he podido entender el audio.";
      const fail: UiMessage = { id: newId("msg"), role: "assistant", text: `No te he podido escuchar bien: ${msg} ¿Me lo escribes?`, createdAt: new Date().toISOString() };
      return { message: fail, changeIds: [], notice };
    }
    if (!transcript) {
      const empty: UiMessage = { id: newId("msg"), role: "assistant", text: "No he oído nada en la nota de voz. ¿Lo repites?", createdAt: new Date().toISOString() };
      return { message: empty, changeIds: [], transcript: "", notice };
    }
  }
  const spoken = [req.text.trim(), transcript].filter(Boolean).join("\n");
  const userText = [spoken, refs].filter(Boolean).join("\n");

  const userUi: UiMessage = {
    id: newId("msg"),
    role: "user",
    text: spoken,
    createdAt: new Date(now).toISOString(),
    hasImages: imageIds.length > 0 || undefined,
    fromVoice: req.audio ? true : undefined,
  };
  const userMsg: LlmMessage = { role: "user", content: userText || "(mensaje vacío)" };

  const history = await loadHistory(env.DB);
  const ctx: ToolContext = {
    env,
    db: env.DB,
    settings,
    calendar,
    imageIds,
    now,
    llm: (opts) => getLlm(env, opts),
    out: { quickReplies: [] },
  };

  let replyText: string;
  let quickReplies: string[] = [];
  let newMessages: LlmMessage[] = [];
  try {
    const run = await runAgent({
      llm: getLlm(env),
      system: buildSystemPrompt(settings, now, detectLanguage(spoken)),
      history: [...history, userMsg],
      tools: [...PHASE1_TOOLS, ...PHASE2_TOOLS, ...PENDING_TOOLS],
      ctx,
    });
    const polished = polish(run.text);
    replyText = polished.text;
    quickReplies = polished.quickReplies.length ? polished.quickReplies : ctx.out.quickReplies;
    newMessages = run.newMessages;
  } catch (err) {
    console.error("agente falló", err);
    replyText =
      err instanceof LlmError
        ? `Ahora mismo no puedo pensar con claridad: ${err.message}`
        : err instanceof GoogleAuthError
          ? err.message
          : "Algo ha fallado por mi lado. Inténtalo otra vez en un momento.";
    newMessages = [{ role: "assistant", content: replyText }];
  }

  const assistantUi: UiMessage = {
    id: newId("msg"),
    role: "assistant",
    text: replyText,
    createdAt: new Date().toISOString(),
    quickReplies: quickReplies.length ? quickReplies : undefined,
    lang: detectLanguage(replyText) ?? detectLanguage(spoken) ?? "es",
  };

  // Se guarda el texto pulido como respuesta final para que el historial sea coherente.
  const last = newMessages[newMessages.length - 1];
  if (last?.role === "assistant" && !last.tool_calls) newMessages[newMessages.length - 1] = { role: "assistant", content: replyText };

  await saveMessages(env.DB, [
    { msg: userMsg, ui: userUi },
    ...newMessages.map((msg, i) => ({ msg, ui: i === newMessages.length - 1 ? assistantUi : undefined })),
  ]);

  return { message: assistantUi, changeIds: calendar.changeIds, preview: ctx.out.preview, notice, transcript };
}
