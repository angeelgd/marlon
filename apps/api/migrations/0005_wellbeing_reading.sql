-- Fase 5: bienestar, lectura, memoria

-- Sesiones de temporizador, meditación y estiramientos.
CREATE TABLE sessions_wellbeing (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('timer', 'meditation', 'stretch')),
  title TEXT NOT NULL,
  phases_json TEXT NOT NULL,
  started_at TEXT NOT NULL,          -- inicio de la fase 0, descontando pausas
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'done', 'cancelled')),
  elapsed_at_pause INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  genre TEXT,
  status TEXT NOT NULL DEFAULT 'reading' CHECK (status IN ('reading', 'finished', 'abandoned')),
  percent REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  opinion TEXT
);

-- Cada "voy por el 40 %" con los minutos leídos (normalmente un trayecto en bus).
CREATE TABLE reading_logs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
  percent REAL NOT NULL,
  minutes INTEGER,
  logged_at TEXT NOT NULL
);
CREATE INDEX idx_reading_logs_book ON reading_logs (book_id, logged_at);

-- Lo que Marlon aprende de Ángel. Se puede ver, editar y borrar desde los ajustes.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  sensitive INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
