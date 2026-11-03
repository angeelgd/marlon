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
import { MONEY_TOOLS } from "./tools/money";
import { FOOD_TOOLS } from "./tools/food";
import { WELLBEING_TOOLS } from "./tools/wellbeing";
import { listMemories, memoryPrompt } from "../memory/store";
import { knowledgePrompt, matchKnowledge } from "../knowledge";
import { saveSettings } from "../db/settings";
import { CONSENT_ALWAYS, CONSENT_NO, CONSENT_ONCE, CONSENT_QUESTION, consentAnswer, looksFinancial } from "../money/sensitivity";

const HISTORY_LIMIT = 30;

export async function calendarFor(env: Env) {
  const settings = await getSettings(env.DB);
  const backend = createBackend(env, settings.googleCalendarId, settings.timezone);
  return { settings, calendar: new CalendarService(env.DB, backend, settings.timezone, settings.googleCalendarId) };
}

/**
 * Historial para el modelo. Con la capa gratuita se quitan los turnos con datos
 * económicos (sensitive = 1): nunca se reenvían por ahí.
 */
async function loadHistory(db: D1Database, includeSensitive: boolean): Promise<LlmMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT content_json FROM messages WHERE (?1 = 1 OR sensitive = 0) ORDER BY created_at DESC, rowid DESC LIMIT ?2`,
    )
    .bind(includeSensitive ? 1 : 0, HISTORY_LIMIT)
    .all<{ content_json: string }>();
  return trimHistory(results.reverse().map((r) => JSON.parse(r.content_json) as LlmMessage), HISTORY_LIMIT);
}

async function saveMessages(db: D1Database, items: { msg: LlmMessage; ui?: UiMessage }[], sensitive: boolean): Promise<void> {
  if (!items.length) return;
  const base = Date.now();
  await db.batch(
    items.map(({ msg, ui }, i) =>
      db
        .prepare(`INSERT INTO messages (id, role, content_json, ui_json, created_at, sensitive) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(
          ui?.id ?? newId("msg"),
          msg.role,
          JSON.stringify(msg),
          ui ? JSON.stringify(ui) : null,
          new Date(base + i).toISOString(),
          sensitive ? 1 : 0,
        ),
    ),
  );
}

const ALL_TOOLS = [...PHASE1_TOOLS, ...PHASE2_TOOLS, ...PENDING_TOOLS, ...MONEY_TOOLS, ...FOOD_TOOLS, ...WELLBEING_TOOLS];

interface StoredTurn {
  spoken: string;
  imageIds: string[];
  fromVoice: boolean;
}

const uiMsg = (role: UiMessage["role"], text: string, extra: Partial<UiMessage> = {}): UiMessage => ({
  id: newId("msg"),
  role,
  text,
  createdAt: new Date().toISOString(),
  ...extra,
});

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

  // Hay proveedor "de pago" (los datos no se usan para entrenar)?
  const paidAvailable = Boolean(env.LLM_PAID_API_KEY) || env.LLM_PROVIDER === "mock";

  // Nota de voz: primero se transcribe (con la clave de pago si la hay) y luego se trata como texto.
  let transcript: string | undefined;
  if (req.audio) {
    try {
      transcript = await transcribe(getLlm(env, { sensitivity: "financial", allowFreeTier: true }), req.audio.data);
    } catch (err) {
      console.error("transcripción falló", err);
      const msg = err instanceof LlmError ? err.message : "No he podido entender el audio.";
      return { message: uiMsg("assistant", `No te he podido escuchar bien: ${msg} ¿Me lo escribes?`), changeIds: [], notice };
    }
    if (!transcript) {
      return { message: uiMsg("assistant", "No he oído nada en la nota de voz. ¿Lo repites?"), changeIds: [], transcript: "", notice };
    }
  }
  let turn: StoredTurn = {
    spoken: [req.text.trim(), transcript].filter(Boolean).join("\n"),
    imageIds,
    fromVoice: Boolean(req.audio),
  };

  /* ------------------ permiso para datos económicos ------------------ */
  let consented = settings.financialFreeTierAlways;
  const answer = imageIds.length === 0 ? consentAnswer(turn.spoken) : null;
  const waiting = answer
    ? await env.DB.prepare(`SELECT id, request_json FROM pending_consents WHERE created_at > ? ORDER BY created_at DESC LIMIT 1`)
        .bind(new Date(now - 30 * 60_000).toISOString())
        .first<{ id: string; request_json: string }>()
    : null;
  if (answer && waiting) {
    await env.DB.prepare(`DELETE FROM pending_consents`).run();
    const answerUi = uiMsg("user", turn.spoken, { createdAt: new Date(now).toISOString() });
    if (answer === "no") {
      const reply = uiMsg("assistant", "Vale, no lo envío. Si quieres, apúntalo a mano en Más > Dinero.");
      await saveMessages(env.DB, [{ msg: { role: "user", content: turn.spoken }, ui: answerUi }, { msg: { role: "assistant", content: reply.text }, ui: reply }], true);
      return { message: reply, changeIds: [], notice };
    }
    if (answer === "always") {
      await saveSettings(env.DB, { financialFreeTierAlways: true });
      settings.financialFreeTierAlways = true;
    }
    await saveMessages(env.DB, [{ msg: { role: "user", content: turn.spoken }, ui: answerUi }], true);
    turn = JSON.parse(waiting.request_json) as StoredTurn;
    consented = true;
  }

  const askConsent = async (alreadySaved: boolean): Promise<ChatResponse> => {
    await env.DB.prepare(`DELETE FROM pending_consents`).run();
    await env.DB.prepare(`INSERT INTO pending_consents (id, request_json) VALUES (?, ?)`).bind(newId("cns"), JSON.stringify(turn)).run();
    const question = uiMsg("assistant", CONSENT_QUESTION, { quickReplies: [CONSENT_ONCE, CONSENT_ALWAYS, CONSENT_NO], lang: "es" });
    const items: { msg: LlmMessage; ui?: UiMessage }[] = [];
    if (!alreadySaved) {
      items.push({
        msg: { role: "user", content: turn.spoken || "(imagen)" },
        ui: uiMsg("user", turn.spoken, { createdAt: new Date(now).toISOString(), hasImages: turn.imageIds.length > 0 || undefined, fromVoice: turn.fromVoice || undefined }),
      });
    }
    items.push({ msg: { role: "assistant", content: question.text }, ui: question });
    await saveMessages(env.DB, items, true);
    return { message: question, changeIds: [], notice, transcript };
  };

  const financialText = looksFinancial(turn.spoken);
  if (financialText && !paidAvailable && !consented) return askConsent(false);

  /* ----------------------------- el turno ----------------------------- */
  const runTurn = async (tier: "free" | "paid", financialAllowed: boolean) => {
    const llm = tier === "paid" ? getLlm(env, { sensitivity: "financial", allowFreeTier: true }) : getLlm(env);
    const refs = turn.imageIds.map((_, i) => `[imagen ${i}] adjunta`).join("\n");
    const userMsg: LlmMessage = { role: "user", content: [turn.spoken, refs].filter(Boolean).join("\n") || "(mensaje vacío)" };
    const ctx: ToolContext = {
      env,
      db: env.DB,
      settings,
      calendar,
      imageIds: turn.imageIds,
      now,
      llm: (opts) => getLlm(env, opts),
      out: { quickReplies: [] },
      financialAllowed,
    };
    // Con datos económicos y capa de pago se puede incluir todo el historial; si no, se omiten.
    const history = await loadHistory(env.DB, tier === "paid" || financialAllowed);
    // Memoria (sin lo económico si va por la capa gratuita) y la guía relevante, si la hay.
    const includeSensitive = tier === "paid" || financialAllowed;
    const memories = memoryPrompt(await listMemories(env.DB, { includeSensitive }));
    const doc = matchKnowledge(turn.spoken)[0]?.doc;
    const system = [buildSystemPrompt(settings, now, detectLanguage(turn.spoken)), memories, doc ? knowledgePrompt(doc) : ""]
      .filter(Boolean)
      .join("\n\n");
    const run = await runAgent({
      llm,
      system,
      history: [...history, userMsg],
      tools: ALL_TOOLS,
      ctx,
    });
    return { run, ctx, userMsg };
  };

  let replyText: string;
  let quickReplies: string[] = [];
  let newMessages: LlmMessage[] = [];
  let ctxOut: ToolContext["out"] = { quickReplies: [] };
  let userMsg: LlmMessage = { role: "user", content: turn.spoken };
  let sensitive = financialText;
  try {
    const financialTier = financialText || consented ? (paidAvailable ? "paid" : "free") : "free";
    let r = await runTurn(financialTier, financialText ? true : consented);
    // Una herramienta de dinero pidió permiso aunque el texto no lo pareciera.
    if (r.ctx.out.needsFinancialConsent && !r.ctx.financialAllowed) {
      if (paidAvailable) r = await runTurn("paid", true);
      else return askConsent(false);
    }
    const polished = polish(r.run.text);
    replyText = polished.text;
    quickReplies = polished.quickReplies.length ? polished.quickReplies : r.ctx.out.quickReplies;
    newMessages = r.run.newMessages;
    ctxOut = r.ctx.out;
    userMsg = r.userMsg;
    sensitive = sensitive || Boolean(r.ctx.out.financialUsed);
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

  const assistantUi = uiMsg("assistant", replyText, {
    quickReplies: quickReplies.length ? quickReplies : undefined,
    lang: detectLanguage(replyText) ?? detectLanguage(turn.spoken) ?? "es",
  });

  // Se guarda el texto pulido como respuesta final para que el historial sea coherente.
  const last = newMessages[newMessages.length - 1];
  if (last?.role === "assistant" && !last.tool_calls) newMessages[newMessages.length - 1] = { role: "assistant", content: replyText };

  // Si veníamos de un permiso, el mensaje del usuario ya se guardó al preguntar.
  const resumed = Boolean(answer && waiting);
  const userUi = uiMsg("user", turn.spoken, {
    createdAt: new Date(now).toISOString(),
    hasImages: turn.imageIds.length > 0 || undefined,
    fromVoice: turn.fromVoice || undefined,
  });
  await saveMessages(
    env.DB,
    [
      ...(resumed ? [{ msg: userMsg }] : [{ msg: userMsg, ui: userUi }]),
      ...newMessages.map((msg, i) => ({ msg, ui: i === newMessages.length - 1 ? assistantUi : undefined })),
    ],
    sensitive || resumed,
  );

  return { message: assistantUi, changeIds: calendar.changeIds, preview: ctxOut.preview, notice, transcript, session: ctxOut.session };
}
