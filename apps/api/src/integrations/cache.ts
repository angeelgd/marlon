/** Caché sencilla en D1 para respuestas de APIs externas. */
export async function cached<T>(db: D1Database, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = new Date().toISOString();
  const row = await db
    .prepare(`SELECT value_json FROM api_cache WHERE key = ? AND expires_at > ?`)
    .bind(key, now)
    .first<{ value_json: string }>();
  if (row) return JSON.parse(row.value_json) as T;
  const value = await load();
  await db
    .prepare(
      `INSERT INTO api_cache (key, value_json, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value_json = ?2, expires_at = ?3`,
    )
    .bind(key, JSON.stringify(value), new Date(Date.now() + ttlMs).toISOString())
    .run();
  return value;
}

export async function purgeExpiredCache(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM api_cache WHERE expires_at < ?`).bind(new Date().toISOString()).run();
}
