import type { Settings } from "@marlon/shared";
import { newGroupId, type BulkOp, type CalendarService } from "../calendar/service";
import { newId } from "../lib/ids";
import { addDays, localToUtcIso, toLocalIso } from "../lib/time";
import { findFreeSlots } from "../schedule/slots";

/**
 * Bloques de estudio en el calendario. Se reparten entre varios días (la práctica
 * espaciada funciona mejor que estudiarlo todo de golpe) y cada bloque lleva un
 * descanso proporcional (por defecto 20 %: 50 min de estudio, 10 de descanso).
 */

export interface StudySession {
  date: string;
  start: number;
  end: number;
  blocks: number;
}

export interface StudyPlanInput {
  fromDate: string;
  toDate: string;
  totalMinutes: number;
  blockMinutes: number;
  breakRatio: number;
  maxBlocksPerDay: number;
  dayStart: string;
  dayEnd: string;
  tz: string;
  busy: { start: number; end: number }[];
  bufferMin: number;
  notBefore: number;
}

export const breakFor = (blockMinutes: number, ratio: number) => Math.max(5, Math.round((blockMinutes * ratio) / 5) * 5);

export function planStudy(input: StudyPlanInput): { sessions: StudySession[]; breakMinutes: number; missingBlocks: number } {
  const breakMin = breakFor(input.blockMinutes, input.breakRatio);
  let needed = Math.ceil(input.totalMinutes / input.blockMinutes);
  const days: string[] = [];
  for (let d = input.fromDate; d <= input.toDate && days.length < 31; d = addDays(d, 1)) days.push(d);
  const perDay = Math.min(input.maxBlocksPerDay, Math.max(1, Math.ceil(needed / Math.max(1, days.length))));
  const sessions: StudySession[] = [];

  // Dos pasadas: primero repartido (perDay), luego relleno hasta el máximo diario si falta.
  for (const cap of [perDay, input.maxBlocksPerDay]) {
    for (const date of days) {
      if (needed <= 0) break;
      const already = sessions.filter((s) => s.date === date).reduce((a, s) => a + s.blocks, 0);
      let room = Math.min(cap, input.maxBlocksPerDay) - already;
      if (room <= 0) continue;
      const busy = [...input.busy, ...sessions.map((s) => ({ start: s.start, end: s.end + breakMin * 60_000 }))];
      const slots = findFreeSlots({
        fromDate: date,
        toDate: date,
        durationMin: input.blockMinutes,
        dayStart: input.dayStart,
        dayEnd: input.dayEnd,
        tz: input.tz,
        busy,
        bufferMin: input.bufferMin,
        notBefore: input.notBefore,
      });
      for (const slot of slots) {
        if (room <= 0 || needed <= 0) break;
        const fit = Math.floor((slot.minutes + breakMin) / (input.blockMinutes + breakMin));
        const blocks = Math.min(fit, room, needed);
        if (blocks <= 0) continue;
        const start = Math.ceil(slot.start / 300_000) * 300_000;
        const minutes = blocks * input.blockMinutes + (blocks - 1) * breakMin;
        if (start + minutes * 60_000 > slot.end) continue;
        sessions.push({ date, start, end: start + minutes * 60_000, blocks });
        room -= blocks;
        needed -= blocks;
      }
    }
  }
  sessions.sort((a, b) => a.start - b.start);
  return { sessions, breakMinutes: breakMin, missingBlocks: Math.max(0, needed) };
}

export async function scheduleStudy(
  calendar: CalendarService,
  settings: Settings,
  opts: { subject: string; fromDate: string; toDate: string; totalMinutes: number; blockMinutes?: number; maxBlocksPerDay?: number; now: number },
) {
  const tz = settings.timezone;
  const blockMinutes = opts.blockMinutes ?? settings.studyBlockMin;
  const events = await calendar.list(localToUtcIso(`${opts.fromDate}T00:00`, tz), localToUtcIso(`${addDays(opts.toDate, 1)}T00:00`, tz));
  const plan = planStudy({
    fromDate: opts.fromDate,
    toDate: opts.toDate,
    totalMinutes: opts.totalMinutes,
    blockMinutes,
    breakRatio: settings.studyBreakRatio,
    maxBlocksPerDay: opts.maxBlocksPerDay ?? 4,
    dayStart: settings.dayStart,
    dayEnd: settings.dayEnd,
    tz,
    busy: events.filter((e) => !e.allDay).map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) })),
    bufferMin: settings.defaultCommuteMin,
    notBefore: opts.now,
  });
  const planId = newId("study");
  const ops: BulkOp[] = plan.sessions.map((s, i) => ({
    op: "create",
    input: {
      title: `Estudio: ${opts.subject}`,
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      kind: "marlon",
      marlonKey: `study:${planId}:${i}`,
      description:
        s.blocks > 1
          ? `${s.blocks} bloques de ${blockMinutes} min con ${plan.breakMinutes} min de descanso entre ellos.`
          : `Un bloque de ${blockMinutes} min.`,
    },
  }));
  const groupId = ops.length ? newGroupId() : null;
  const { items } = ops.length ? await calendar.bulk(ops, { actor: "marlon", groupId }) : { items: [] };
  return {
    groupId,
    blockMinutes,
    breakMinutes: plan.breakMinutes,
    missingBlocks: plan.missingBlocks,
    sessions: plan.sessions.map((s, i) => ({
      date: s.date,
      start: toLocalIso(s.start, tz),
      end: toLocalIso(s.end, tz),
      blocks: s.blocks,
      saved: items[i]?.ok ?? false,
    })),
  };
}
