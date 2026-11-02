import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/loop";
import { PHASE1_TOOLS } from "../src/agent/tools";
import { executeTool, toToolDef } from "../src/agent/tools/types";
import { localToUtcIso, toLocalIso } from "../src/lib/time";
import { say, scripted, testCtx, testEnv, toolCall, TZ } from "./helpers";

describe("definición de herramientas", () => {
  it("genera JSON Schema limpio para todas las herramientas", () => {
    for (const t of PHASE1_TOOLS) {
      const def = toToolDef(t);
      const json = JSON.stringify(def);
      expect(json).not.toContain("$schema");
      expect(json).not.toContain("additionalProperties");
      expect(def.function.parameters.type).toBe("object");
    }
  });

  it("rechaza argumentos no válidos con una pista", async () => {
    const ctx = testCtx(testEnv());
    const r = await executeTool(PHASE1_TOOLS, "create_event", JSON.stringify({ title: "X", start: "mañana", end: "luego" }), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("Argumentos no válidos.");
      expect(r.hint).toContain("start");
    }
  });

  it("avisa si la herramienta no existe o el JSON está roto", async () => {
    const ctx = testCtx(testEnv());
    expect((await executeTool(PHASE1_TOOLS, "nope", "{}", ctx)).ok).toBe(false);
    expect((await executeTool(PHASE1_TOOLS, "list_events", "{no json", ctx)).ok).toBe(false);
  });
});

describe("bucle del agente", () => {
  it("se corrige tras un error de validación y mueve el evento", async () => {
    const env = testEnv();
    const ctx = testCtx(env);
    const ev = await ctx.calendar.create({
      title: "Gimnasio",
      start: localToUtcIso("2026-11-03T08:00", TZ),
      end: localToUtcIso("2026-11-03T09:30", TZ),
      kind: "gym",
    });

    const llm = scripted([
      () => toolCall("move_event", { event_id: ev.id, new_start: "jueves a las 18" }, "a"),
      (req) => {
        const last = req.messages[req.messages.length - 1]!;
        expect(last.role).toBe("tool");
        expect(String(last.content)).toContain("Argumentos no válidos");
        return toolCall("move_event", { event_id: ev.id, new_start: "2026-11-05T18:00" }, "b");
      },
      () => say("Listo — te lo he pasado al jueves a las 18:00."),
    ]);

    const run = await runAgent({ llm, system: "sys", history: [{ role: "user", content: "pásalo al jueves" }], tools: PHASE1_TOOLS, ctx });
    expect(run.text).toContain("jueves");
    expect(run.toolsUsed).toEqual(["move_event", "move_event"]);
    // assistant(tool) + tool + assistant(tool) + tool + assistant(texto)
    expect(run.newMessages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool", "assistant"]);

    const moved = (await ctx.calendar.get(ev.id))!;
    expect(toLocalIso(Date.parse(moved.start), TZ)).toBe("2026-11-05T18:00");
    expect(toLocalIso(Date.parse(moved.end), TZ)).toBe("2026-11-05T19:30");
    const history = await ctx.calendar.history();
    expect(history.map((h) => h.action)).toEqual(["move", "create"]);
  });

  it("corta tras el máximo de pasos", async () => {
    const ctx = testCtx(testEnv());
    const loop = () => toolCall("list_events", { from_date: "2026-11-01", to_date: "2026-11-02" });
    const llm = scripted([loop, loop, () => say("fin")]);
    const run = await runAgent({ llm, system: "s", history: [{ role: "user", content: "x" }], tools: PHASE1_TOOLS, ctx, maxSteps: 3 });
    expect(run.text).toBe("fin");
    // En el último paso no se ofrecen herramientas.
    expect(llm.calls[2]!.tools).toBeUndefined();
  });
});

describe("find_free_slots", () => {
  it("devuelve huecos en hora local alrededor de los eventos", async () => {
    const ctx = testCtx(testEnv(), Date.parse("2026-11-01T00:00:00Z"));
    await ctx.calendar.create({
      title: "Trabajo",
      start: localToUtcIso("2026-11-02T15:45", TZ),
      end: localToUtcIso("2026-11-02T22:00", TZ),
      kind: "work_planned",
    });
    const r = await executeTool(
      PHASE1_TOOLS,
      "find_free_slots",
      JSON.stringify({ from_date: "2026-11-02", to_date: "2026-11-02", duration_minutes: 80, day_start: "07:00", day_end: "23:00" }),
      ctx,
    );
    expect(r).toEqual({
      ok: true,
      data: { slots: [{ date: "2026-11-02", start: "2026-11-02T07:00", end: "2026-11-02T15:45", minutes: 525 }] },
    });
  });
});
