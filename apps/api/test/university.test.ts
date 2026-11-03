import { describe, expect, it } from "vitest";
import { syncUniversity } from "../src/university/sync";
import { localToUtcIso, toLocalIso } from "../src/lib/time";
import { fakeFetch } from "./fakes";
import { testCtx, testEnv, TZ } from "./helpers";

const NOW = Date.parse("2026-11-01T10:00:00Z");

function feed(events: string) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.trim().replace(/\n/g, "\r\n")}\r\nEND:VCALENDAR`;
}
const vevent = (uid: string, start: string, end: string, summary: string, extra = "") => `BEGIN:VEVENT
UID:${uid}
DTSTART;TZID=Europe/Helsinki:${start}
DTEND;TZID=Europe/Helsinki:${end}
SUMMARY:${summary}
LOCATION:ICT_B2039${extra ? `\n${extra}` : ""}
END:VEVENT`;

describe("sincronización del calendario de la uni", () => {
  it("sin URL no hace nada", async () => {
    const env = testEnv();
    const ctx = testCtx(env, NOW);
    expect((await syncUniversity(env, ctx.calendar, ctx.settings, { now: NOW })).skipped).toBe("no_url");
  });

  it("crea, no duplica, actualiza, quita canceladas y desaparecidas, y detecta solapes con el trabajo", async () => {
    const env = testEnv({ UNIVERSITY_ICAL_URL: "https://lukkari.example/ical?hash=SECRETO" });
    const ctx = testCtx(env, NOW);
    let body = feed(
      [
        vevent("a", "20261102T081500", "20261102T100000", "Web Dev"),
        vevent("b", "20261103T160000", "20261103T180000", "Databases"),
        vevent("c", "20261104T120000", "20261104T140000", "Math"),
      ].join("\n"),
    );
    const { fn, calls } = fakeFetch([[/lukkari/, () => new Response(body)]]);

    // Turno el martes que pisa la clase de Databases.
    await ctx.calendar.create({
      title: "Trabajo",
      start: localToUtcIso("2026-11-03T15:45", TZ),
      end: localToUtcIso("2026-11-03T22:00", TZ),
      kind: "work_planned",
      marlonKey: "work:2026-11-03",
    });

    const r1 = await syncUniversity(env, ctx.calendar, ctx.settings, { now: NOW, fetchImpl: fn });
    expect(r1).toMatchObject({ created: 3, changed: 0, removed: 0, unchanged: 0, failed: [] });
    expect(r1.conflicts).toHaveLength(1);
    expect(r1.conflicts[0]!.other.title).toBe("Databases");
    expect(calls[0]!.url).toContain("hash=SECRETO");

    const r2 = await syncUniversity(env, ctx.calendar, ctx.settings, { now: NOW, fetchImpl: fn });
    expect(r2).toMatchObject({ created: 0, changed: 0, removed: 0, unchanged: 3 });
    expect(await ctx.calendar.listByKeyPrefix("uni:")).toHaveLength(3);

    body = feed(
      [
        vevent("a", "20261102T090000", "20261102T110000", "Web Dev"), // cambia de hora
        vevent("b", "20261103T160000", "20261103T180000", "Databases", "STATUS:CANCELLED"),
        // "c" desaparece del iCal
      ].join("\n"),
    );
    const r3 = await syncUniversity(env, ctx.calendar, ctx.settings, { now: NOW, fetchImpl: fn });
    expect(r3).toMatchObject({ created: 0, changed: 1, removed: 2 });
    expect(r3.conflicts).toEqual([]);
    const left = await ctx.calendar.listByKeyPrefix("uni:");
    expect(left.map((e) => `${e.title} ${toLocalIso(Date.parse(e.start), TZ)}`)).toEqual(["Web Dev 2026-11-02T09:00"]);
    expect(left[0]!.kind).toBe("university");
  });

  it("si el iCal falla, lanza un error sin mostrar la URL", async () => {
    const env = testEnv({ UNIVERSITY_ICAL_URL: "https://lukkari.example/ical?hash=SECRETO" });
    const ctx = testCtx(env, NOW);
    const { fn } = fakeFetch([[/lukkari/, () => new Response("no", { status: 500 })]]);
    const err = await syncUniversity(env, ctx.calendar, ctx.settings, { now: NOW, fetchImpl: fn }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("SECRETO");
  });
});
