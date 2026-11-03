import { describe, expect, it } from "vitest";
import { birthdayNotices, nextNudge, nudgeText, type DayFrame } from "../src/pendings/nudges";
import { addPending, closePending, findPendings, getPendingRow, nextBirthday, recordNudge, type PendingRow } from "../src/pendings/store";
import { enqueue } from "../src/push/scheduler";
import { localToMs, toLocalIso } from "../src/lib/time";
import { testEnv, TZ } from "./helpers";

const at = (s: string) => localToMs(s, TZ);
const t = (ms: number) => toLocalIso(ms, TZ);

const frame: DayFrame = {
  date: "2026-11-02",
  tz: TZ,
  wake: at("2026-11-02T08:30"),
  quietFrom: at("2026-11-02T22:30"),
  busy: [{ start: at("2026-11-02T15:45"), end: at("2026-11-02T22:00") }],
};

const row = (over: Partial<PendingRow> = {}): PendingRow => ({
  id: "p1",
  kind: "reminder",
  title: "Contestar a Mateo",
  person: "Mateo",
  notes: null,
  area: "personal",
  due_date: "2026-11-02",
  due_time: null,
  birthday_md: null,
  horizon: null,
  status: "open",
  created_at: new Date(at("2026-11-02T09:10")).toISOString(),
  done_at: null,
  nudge_date: null,
  nudge_count: 0,
  last_nudge_at: null,
  snoozed_until: null,
  ...over,
});

describe("insistencia gradual", () => {
  it("primer aviso una hora después de crearlo", () => {
    expect(t(nextNudge(row(), frame, at("2026-11-02T09:15"))!.at)).toBe("2026-11-02T10:10");
  });

  it("si tiene hora, avisa a esa hora", () => {
    expect(t(nextNudge(row({ due_time: "12:00" }), frame, at("2026-11-02T09:15"))!.at)).toBe("2026-11-02T12:00");
  });

  it("cada aviso llega antes que el anterior y cambia el tono", () => {
    const gaps: number[] = [];
    let p = row();
    let last = at("2026-11-02T10:10");
    const texts: string[] = [];
    for (let i = 1; i <= 3; i++) {
      p = { ...p, nudge_date: "2026-11-02", nudge_count: i, last_nudge_at: new Date(last).toISOString() };
      const n = nextNudge(p, { ...frame, busy: [] }, last)!;
      gaps.push((n.at - last) / 60_000);
      texts.push(n.body);
      last = n.at;
    }
    expect(gaps).toEqual([180, 120, 90]);
    expect(new Set(texts).size).toBe(3);
  });

  it("no avisa en mitad de un turno: espera a que acabe", () => {
    const p = row({ nudge_date: "2026-11-02", nudge_count: 1, last_nudge_at: new Date(at("2026-11-02T14:00")).toISOString() });
    // 14:00 + 180 min = 17:00, en pleno turno (15:45 a 22:00) → 22:10.
    expect(t(nextNudge(p, frame, at("2026-11-02T14:00"))!.at)).toBe("2026-11-02T22:10");
  });

  it("no avisa a partir de la hora de irse a dormir", () => {
    const p = row({ nudge_date: "2026-11-02", nudge_count: 2, last_nudge_at: new Date(at("2026-11-02T21:00")).toISOString() });
    expect(nextNudge(p, { ...frame, busy: [] }, at("2026-11-02T21:00"))).toBeNull();
  });

  it("tiene un máximo de avisos al día y deja de avisar cuando está hecho", () => {
    expect(nextNudge(row({ nudge_date: "2026-11-02", nudge_count: 6 }), frame, at("2026-11-02T12:00"))).toBeNull();
    expect(nextNudge(row({ status: "done" }), frame, at("2026-11-02T12:00"))).toBeNull();
    expect(nextNudge(row({ due_date: "2026-11-05" }), frame, at("2026-11-02T12:00"))).toBeNull();
    expect(nextNudge(row({ kind: "plan" }), frame, at("2026-11-02T12:00"))).toBeNull();
  });

  it("lo vencido de días anteriores se recuerda como mucho dos veces al día", () => {
    const p = row({ due_date: "2026-11-01", created_at: new Date(at("2026-11-01T10:00")).toISOString() });
    const n = nextNudge(p, frame, at("2026-11-02T08:00"))!;
    expect(t(n.at)).toBe("2026-11-02T09:00");
    expect(n.body).toContain("Ayer quedó sin hacer");
    expect(nextNudge({ ...p, nudge_date: "2026-11-02", nudge_count: 2 }, frame, at("2026-11-02T12:00"))).toBeNull();
  });

  it("respeta el aplazamiento", () => {
    const p = row({ snoozed_until: new Date(at("2026-11-02T13:00")).toISOString() });
    expect(t(nextNudge(p, frame, at("2026-11-02T10:00"))!.at)).toBe("2026-11-02T13:00");
  });

  it("los textos no usan guiones como puntuación", () => {
    for (let i = 0; i < 7; i++) {
      for (const overdue of [false, true]) {
        const { title, body } = nudgeText("Contestar a Mateo", i, overdue);
        expect(`${title} ${body}`).not.toMatch(/[—–]| - /);
      }
    }
  });
});

describe("cumpleaños", () => {
  it("siguiente fecha, también con el 29 de febrero", () => {
    expect(nextBirthday("12-05", "2026-11-02")).toBe("2026-12-05");
    expect(nextBirthday("03-10", "2026-11-02")).toBe("2027-03-10");
    expect(nextBirthday("11-02", "2026-11-02")).toBe("2026-11-02");
    expect(nextBirthday("02-29", "2026-11-02")).toBe("2027-02-28");
    expect(nextBirthday("02-29", "2027-03-01")).toBe("2028-02-29");
  });

  it("avisa una semana antes y el mismo día", () => {
    const p = row({ kind: "birthday", title: "Cumpleaños de Laura", person: "Laura", due_date: "2026-11-09", birthday_md: "11-09" });
    const before = birthdayNotices(p, frame, 7);
    expect(before).toHaveLength(1);
    expect(before[0]!.body).toBe("El cumpleaños de Laura es dentro de 7 días. ¿Quieres preparar algo?");
    const day = birthdayNotices({ ...p, due_date: "2026-11-02" }, frame, 7);
    expect(day[0]!.title).toBe("Hoy es su cumpleaños");
  });
});

describe("guardar y cerrar pendientes", () => {
  const NOW = at("2026-11-02T09:10");

  it("un recordatorio sin fecha es para hoy; un cumpleaños calcula la próxima fecha", async () => {
    const env = testEnv();
    const r = await addPending(env.DB, { kind: "reminder", title: "Contestar a Mateo", person: "Mateo" }, NOW, TZ);
    expect(r).toMatchObject({ dueDate: "2026-11-02", status: "open", kind: "reminder" });
    const b = await addPending(env.DB, { kind: "birthday", title: "Cumpleaños de Laura", person: "Laura", birthday: "1999-03-10" }, NOW, TZ);
    expect(b.dueDate).toBe("2027-03-10");
    await expect(addPending(env.DB, { kind: "birthday", title: "Cumple" }, NOW, TZ)).rejects.toThrow("día y el mes");
    const plan = await addPending(env.DB, { kind: "plan", title: "Aprender sueco", horizon: "long" }, NOW, TZ);
    expect(plan).toMatchObject({ horizon: "long", dueDate: null });
  });

  it("encuentra el pendiente por palabras clave", async () => {
    const env = testEnv();
    await addPending(env.DB, { kind: "reminder", title: "Contestar a Mateo", person: "Mateo" }, NOW, TZ);
    await addPending(env.DB, { kind: "reminder", title: "Responder el correo sobre las prácticas" }, NOW, TZ);
    expect((await findPendings(env.DB, "ya le contesté a Mateo")).map((p) => p.title)).toEqual(["Contestar a Mateo"]);
    expect((await findPendings(env.DB, "lo del correo de prácticas")).map((p) => p.title)).toEqual([
      "Responder el correo sobre las prácticas",
    ]);
    expect(await findPendings(env.DB, "algo que no existe")).toEqual([]);
  });

  it("al cerrar se cancelan sus avisos en cola; un cumpleaños pasa al año siguiente", async () => {
    const env = testEnv();
    const r = await addPending(env.DB, { kind: "reminder", title: "Contestar a Mateo" }, NOW, TZ);
    await enqueue(env.DB, { key: `nudge:${r.id}:2026-11-02:1`, kind: "nudge", at: NOW + 3_600_000, title: "x", body: "y" });
    await recordNudge(env.DB, r.id, "2026-11-02", 1, NOW);
    await closePending(env.DB, r.id, NOW, TZ);
    expect((await getPendingRow(env.DB, r.id))!.status).toBe("done");
    const q = await env.DB.prepare(`SELECT status FROM notifications`).first<{ status: string }>();
    expect(q!.status).toBe("cancelled");

    const b = await addPending(env.DB, { kind: "birthday", title: "Cumpleaños de Laura", birthday: "11-02" }, NOW, TZ);
    expect(b.dueDate).toBe("2026-11-02");
    const closed = await closePending(env.DB, b.id, NOW, TZ);
    expect(closed).toMatchObject({ status: "open", dueDate: "2027-11-02" });
  });
});
