import { describe, expect, it } from "vitest";
import { newGroupId } from "../src/calendar/service";
import { localToUtcIso } from "../src/lib/time";
import { testCtx, testEnv, TZ } from "./helpers";

const at = (s: string) => localToUtcIso(s, TZ);

describe("CalendarService", () => {
  it("lista por rango y deshace crear, mover y borrar", async () => {
    const { calendar } = testCtx(testEnv());
    const a = await calendar.create({ title: "Clase", start: at("2026-11-02T09:00"), end: at("2026-11-02T11:00"), kind: "university" });
    const b = await calendar.create({ title: "Gimnasio", start: at("2026-11-03T08:00"), end: at("2026-11-03T09:20"), kind: "gym" });

    expect((await calendar.list(at("2026-11-02T00:00"), at("2026-11-03T00:00"))).map((e) => e.title)).toEqual(["Clase"]);

    await calendar.move(b.id, at("2026-11-04T18:00"), null);
    expect((await calendar.get(b.id))!.end).toBe(at("2026-11-04T19:20"));
    await calendar.remove(a.id);
    expect(await calendar.get(a.id)).toBeNull();

    const hist = await calendar.history();
    expect(hist.map((h) => h.action)).toEqual(["delete", "move", "create", "create"]);

    // Deshacer el borrado: vuelve a existir (con id nuevo en el backend).
    await calendar.undo(hist[0]!.id);
    expect((await calendar.list(at("2026-11-02T00:00"), at("2026-11-03T00:00"))).map((e) => e.title)).toEqual(["Clase"]);

    // Deshacer el movimiento.
    await calendar.undo(hist[1]!.id);
    expect((await calendar.get(b.id))!.start).toBe(at("2026-11-03T08:00"));

    await expect(calendar.undo(hist[1]!.id)).rejects.toThrow("ya estaba deshecho");
  });

  it("deshace un grupo entero de una vez", async () => {
    const { calendar } = testCtx(testEnv());
    const groupId = newGroupId();
    await calendar.create({ title: "T1", start: at("2026-11-02T15:00"), end: at("2026-11-02T22:00"), kind: "work_planned" }, { groupId });
    await calendar.create({ title: "T2", start: at("2026-11-03T15:00"), end: at("2026-11-03T22:00"), kind: "work_planned" }, { groupId });
    const hist = await calendar.history();
    expect(await calendar.undo(hist[1]!.id)).toBe(2);
    expect(await calendar.list(at("2026-11-01T00:00"), at("2026-11-10T00:00"))).toEqual([]);
  });

  it("no acepta eventos que acaban antes de empezar", async () => {
    const { calendar } = testCtx(testEnv());
    await expect(
      calendar.create({ title: "X", start: at("2026-11-02T10:00"), end: at("2026-11-02T09:00"), kind: "marlon" }),
    ).rejects.toThrow();
  });
});
