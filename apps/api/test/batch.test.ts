import { describe, expect, it } from "vitest";
import { GoogleBackend, parseBatchResponse } from "../src/calendar/backend";
import { fakeFetch, json } from "./fakes";
import { testEnv } from "./helpers";

const CT = "multipart/mixed; boundary=batch_abc";
const part = (i: number, status: string, body = "") =>
  `--batch_abc\r\nContent-Type: application/http\r\nContent-ID: <response-item${i}>\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n`;

describe("API batch de Google Calendar", () => {
  it("interpreta la respuesta multipart por Content-ID, aunque venga desordenada", () => {
    const text = part(1, "204 No Content") + part(0, "200 OK", '{"id":"g1"}') + part(2, "404 Not Found", '{"error":{}}') + "--batch_abc--";
    const map = parseBatchResponse(CT, text);
    expect(map.get(0)).toEqual({ status: 200, body: '{"id":"g1"}' });
    expect(map.get(1)!.status).toBe(204);
    expect(map.get(2)!.status).toBe(404);
  });

  it("envía un solo POST multipart y devuelve un resultado por operación", async () => {
    const { fn, calls } = fakeFetch([
      [/oauth2\.googleapis\.com\/token/, () => json({ access_token: "tok", expires_in: 3600 })],
      [
        /batch\/calendar\/v3/,
        () =>
          new Response(
            part(0, "200 OK", JSON.stringify({ id: "new1", summary: "A", start: { dateTime: "2026-11-02T10:00:00+02:00" }, end: { dateTime: "2026-11-02T11:00:00+02:00" } })) +
              part(1, "404 Not Found", "{}") +
              part(2, "403 Forbidden", '{"error":"x"}') +
              "--batch_abc--",
            { status: 200, headers: { "content-type": CT } },
          ),
      ],
    ]);
    const env = testEnv({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r" });
    const b = new GoogleBackend(env, "primary", "Europe/Helsinki", fn);
    const res = await b.batch([
      { op: "insert", ev: { title: "A", start: "2026-11-02T08:00:00.000Z", end: "2026-11-02T09:00:00.000Z", kind: "marlon" } },
      { op: "remove", id: "gone" },
      { op: "patch", id: "x", ev: { title: "B" } },
    ]);
    const batchCalls = calls.filter((c) => c.url.includes("batch"));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]!.body).toContain("POST /calendar/v3/calendars/primary/events HTTP/1.1");
    expect(batchCalls[0]!.body).toContain("DELETE /calendar/v3/calendars/primary/events/gone HTTP/1.1");
    expect(batchCalls[0]!.body).toContain('"marlonKind":"marlon"');
    expect(res[0]).toMatchObject({ ok: true, event: { id: "new1", title: "A" } });
    // Borrar algo que ya no existe cuenta como hecho.
    expect(res[1]).toEqual({ ok: true, event: null });
    expect(res[2]!.ok).toBe(false);
  });
});
