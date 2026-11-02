/**
 * D1 en memoria sobre node:sqlite para los tests. Implementa lo que usa la app:
 * prepare().bind().first/all/run, batch y exec.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Param = string | number | null | bigint | Uint8Array;

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private params: Param[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(
      this.db,
      this.sql,
      params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as Param))),
    );
  }
  async first<T>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T>() {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }, results: [] };
  }
  async raw() {
    return this.db.prepare(this.sql).all(...this.params).map((r) => Object.values(r as object));
  }
}

export function createTestDb(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
  const d1 = {
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.all());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump() {
      throw new Error("no implementado");
    },
    withSession() {
      return d1;
    },
  };
  return d1 as unknown as D1Database;
}
