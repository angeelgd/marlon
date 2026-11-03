import type { Settings } from "@marlon/shared";
import type { EventInput } from "../calendar/backend";
import { newGroupId, type BulkOp, type CalendarService } from "../calendar/service";
import type { Env } from "../env";
import { nowIso } from "../lib/ids";
import { conflictsInRange, type Conflict } from "../planning/conflicts";
import { parseIcal, type IcalEvent } from "./ical";
import { universityIcalUrl } from "./source";

/** Días hacia delante que se sincronizan del calendario de la uni. */
const HORIZON_DAYS = 120;
const STATE_ID = "university-ical";

export interface UniversitySyncResult {
  skipped?: "no_url";
  created: number;
  changed: number;
  removed: number;
  unchanged: number;
  failed: string[];
  conflicts: Conflict[];
  groupId: string | null;
}

export const uniKey = (ev: Pick<IcalEvent, "key">) => `uni:${ev.key}`;

function toInput(ev: IcalEvent): EventInput {
  return {
    title: ev.title,
    start: ev.start,
    end: ev.end,
    location: ev.location,
    description: ev.description,
    kind: "university",
    marlonKey: uniKey(ev),
  };
}

/** Descarga el iCal y comprueba que lo es (un enlace a la web de Lukkari devuelve HTML). */
export async function fetchIcal(url: string, fetchImpl?: typeof fetch): Promise<string> {
  let res: Response;
  try {
    res = await (fetchImpl ?? fetch)(url, { headers: { accept: "text/calendar" } });
  } catch {
    throw new Error("No se pudo descargar el calendario de la uni. Revisa el enlace.");
  }
  if (!res.ok) throw new Error(`El calendario de la uni respondió ${res.status}. Revisa que el enlace siga activo.`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error("Ese enlace no devuelve un calendario. En Lukkari, copia el enlace de exportación iCal (el que lleva hash=).");
  }
  return text;
}

/**
 * Trae el iCal de Lukkari y lo refleja en el calendario sin duplicar:
 * cada clase se identifica por UID + inicio original.
 * La URL es secreta (su parámetro hash= funciona como contraseña): nunca se registra.
 */
export async function syncUniversity(
  env: Env,
  calendar: CalendarService,
  settings: Settings,
  opts: { now?: number; fetchImpl?: typeof fetch; url?: string } = {},
): Promise<UniversitySyncResult> {
  const empty: UniversitySyncResult = { created: 0, changed: 0, removed: 0, unchanged: 0, failed: [], conflicts: [], groupId: null };
  const url = opts.url ?? (await universityIcalUrl(env)).url;
  if (!url) return { ...empty, skipped: "no_url" };

  const now = opts.now ?? Date.now();
  const from = now - 86_400_000; // no se toca el pasado
  const to = now + HORIZON_DAYS * 86_400_000;

  const feed = parseIcal(await fetchIcal(url, opts.fetchImpl), { defaultTz: settings.timezone, from, to });

  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const existing = await calendar.listByKeyPrefix("uni:", fromIso, toIso);
  const byKey = new Map(existing.map((e) => [e.marlonKey!, e]));

  const ops: BulkOp[] = [];
  const seen = new Set<string>();
  let unchanged = 0;
  for (const ev of feed) {
    const key = uniKey(ev);
    if (seen.has(key)) continue;
    seen.add(key);
    const cur = byKey.get(key);
    if (ev.cancelled) {
      if (cur) ops.push({ op: "remove", id: cur.id });
      continue;
    }
    if (!cur) {
      ops.push({ op: "create", input: toInput(ev) });
    } else if (
      cur.start !== ev.start ||
      cur.end !== ev.end ||
      cur.title !== ev.title ||
      (cur.location ?? null) !== (ev.location ?? null)
    ) {
      ops.push({ op: "update", id: cur.id, fields: { title: ev.title, start: ev.start, end: ev.end, location: ev.location } });
    } else {
      unchanged++;
    }
  }
  // Clases futuras que ya no están en el iCal: se quitan.
  for (const e of existing) {
    if (!seen.has(e.marlonKey!) && Date.parse(e.start) >= now) ops.push({ op: "remove", id: e.id });
  }

  const groupId = ops.length ? newGroupId() : null;
  const { items } = ops.length ? await calendar.bulk(ops, { actor: "marlon", groupId }) : { items: [] };
  const result: UniversitySyncResult = { ...empty, unchanged, groupId };
  items.forEach((it, i) => {
    if (!it.ok) return void result.failed.push(it.error);
    const op = ops[i]!.op;
    if (op === "create") result.created++;
    else if (op === "remove") result.removed++;
    else result.changed++;
  });

  await env.DB.prepare(
    `INSERT INTO sync_state (calendar_id, sync_token, last_sync_at) VALUES (?1, NULL, ?2)
     ON CONFLICT(calendar_id) DO UPDATE SET last_sync_at = ?2`,
  )
    .bind(STATE_ID, nowIso())
    .run();

  result.conflicts = await conflictsInRange(calendar, new Date(now).toISOString(), toIso);
  return result;
}
