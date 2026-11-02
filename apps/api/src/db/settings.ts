import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from "@marlon/shared";

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare(`SELECT key, value_json FROM settings`).all<{ key: string; value_json: string }>();
  const raw: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of results) {
    try {
      raw[r.key] = JSON.parse(r.value_json);
    } catch {
      /* valor corrupto: se usa el de por defecto */
    }
  }
  const parsed = SettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(db: D1Database, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(db);
  const next = SettingsSchema.parse({ ...current, ...patch });
  const stmts = Object.entries(next).map(([k, v]) =>
    db
      .prepare(`INSERT INTO settings (key, value_json) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value_json = ?2`)
      .bind(k, JSON.stringify(v)),
  );
  await db.batch(stmts);
  return next;
}
