-- Fase 2: planificación

-- Caché de llamadas externas (tiempo y rutas) para ahorrar cuota.
CREATE TABLE api_cache (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_api_cache_expires ON api_cache (expires_at);
