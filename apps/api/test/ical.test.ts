import { describe, expect, it } from "vitest";
import { parseDuration, parseIcal, parseIcalDate, unescapeText } from "../src/university/ical";
import { localToMs, toLocalIso } from "../src/lib/time";

const TZ = "Europe/Helsinki";
const win = { defaultTz: TZ, from: Date.parse("2026-08-01T00:00:00Z"), to: Date.parse("2027-01-31T00:00:00Z") };
const local = (iso: string) => toLocalIso(Date.parse(iso), TZ);

const ics = (body: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Lukkari//FI", body.trim(), "END:VCALENDAR"].join("\r\n");

describe("iCal: piezas", () => {
  it("fechas en UTC, con TZID, flotantes y de día completo", () => {
    expect(new Date(parseIcalDate("20261102T081500Z", {}, TZ).ms).toISOString()).toBe("2026-11-02T08:15:00.000Z");
    expect(parseIcalDate("20261102T101500", { TZID: "Europe/Helsinki" }, TZ).ms).toBe(localToMs("2026-11-02T10:15", TZ));
    // Zona de Windows desconocida: se usa la de por defecto.
    expect(parseIcalDate("20261102T101500", { TZID: "FLE Standard Time" }, TZ).ms).toBe(localToMs("2026-11-02T10:15", TZ));
    expect(parseIcalDate("20261102", { VALUE: "DATE" }, TZ)).toEqual({ ms: localToMs("2026-11-02T00:00", TZ), allDay: true });
  });

  it("duraciones y texto escapado", () => {
    expect(parseDuration("PT1H30M")).toBe(90 * 60_000);
    expect(parseDuration("P1D")).toBe(86_400_000);
    expect(unescapeText("Aula 1\\, edificio ICT\\nLab")).toBe("Aula 1, edificio ICT\nLab");
  });
});

describe("parseIcal", () => {
  it("lee eventos simples con líneas plegadas y VALARM", () => {
    const text = ics(`
BEGIN:VEVENT
UID:abc-1@lukkari
DTSTAMP:20260901T000000Z
DTSTART;TZID=Europe/Helsinki:20261102T081500
DTEND;TZID=Europe/Helsinki:20261102T100000
SUMMARY:Web Development
  Project
LOCATION:ICT_B2039
BEGIN:VALARM
TRIGGER:-PT15M
ACTION:DISPLAY
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:abc-2@lukkari
DTSTART:20261103T120000Z
DURATION:PT2H
SUMMARY:Databases
STATUS:CANCELLED
END:VEVENT`);
    const ev = parseIcal(text, win);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ uid: "abc-1@lukkari", title: "Web Development Project", location: "ICT_B2039", cancelled: false });
    expect(local(ev[0]!.start)).toBe("2026-11-02T08:15");
    expect(local(ev[0]!.end)).toBe("2026-11-02T10:00");
    expect(ev[1]).toMatchObject({ cancelled: true });
    expect(local(ev[1]!.end)).toBe("2026-11-03T16:00");
  });

  it("expande RRULE semanal manteniendo la hora con el cambio de horario, con EXDATE y RECURRENCE-ID", () => {
    const text = ics(`
BEGIN:VEVENT
UID:rec-1
DTSTART;TZID=Europe/Helsinki:20261019T090000
DTEND;TZID=Europe/Helsinki:20261019T103000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID=Europe/Helsinki:20261102T090000
SUMMARY:Mathematics
END:VEVENT
BEGIN:VEVENT
UID:rec-1
RECURRENCE-ID;TZID=Europe/Helsinki:20261109T090000
DTSTART;TZID=Europe/Helsinki:20261109T130000
DTEND;TZID=Europe/Helsinki:20261109T143000
SUMMARY:Mathematics (moved)
END:VEVENT`);
    const ev = parseIcal(text, win);
    expect(ev.map((e) => [local(e.start), e.title])).toEqual([
      ["2026-10-19T09:00", "Mathematics"],
      // 25 de octubre cambia la hora: la clase sigue a las 09:00.
      ["2026-10-26T09:00", "Mathematics"],
      ["2026-11-09T13:00", "Mathematics (moved)"],
    ]);
    // La clave usa el inicio original, así mover la instancia no la duplica.
    expect(ev[2]!.key).toBe(`rec-1|${new Date(localToMs("2026-11-09T09:00", TZ)).toISOString()}`);
  });

  it("BYDAY e INTERVAL", () => {
    const text = ics(`
BEGIN:VEVENT
UID:rec-2
DTSTART;TZID=Europe/Helsinki:20261102T120000
DTEND;TZID=Europe/Helsinki:20261102T130000
RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261125T235959Z
SUMMARY:Seminar
END:VEVENT`);
    expect(parseIcal(text, win).map((e) => local(e.start).slice(0, 10))).toEqual([
      "2026-11-02",
      "2026-11-04",
      "2026-11-16",
      "2026-11-18",
    ]);
  });

  it("filtra por la ventana de fechas", () => {
    const text = ics(`
BEGIN:VEVENT
UID:old
DTSTART:20250101T100000Z
DTEND:20250101T110000Z
SUMMARY:Old
END:VEVENT`);
    expect(parseIcal(text, win)).toEqual([]);
  });
});
