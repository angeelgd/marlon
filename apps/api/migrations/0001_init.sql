-- Fase 1: núcleo

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

-- Passkeys (WebAuthn). Un solo usuario.
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,               -- credential id (base64url)
  public_key TEXT NOT NULL,          -- base64url
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                   -- JSON
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  expires_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

-- Historial del chat en formato de mensajes del modelo (JSON).
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content_json TEXT NOT NULL,
  ui_json TEXT,                      -- lo que se pinta en la interfaz (null = interno)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_messages_created ON messages (created_at);

-- Copia local de los eventos de Google Calendar.
CREATE TABLE events_cache (
  id TEXT PRIMARY KEY,               -- id del evento en Google (o local-*)
  calendar_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,            -- ISO UTC
  end_at TEXT NOT NULL,              -- ISO UTC
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'manual',
  marlon_key TEXT,                   -- extendedProperties.private.marlonKey
  etag TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_range ON events_cache (deleted, start_at, end_at);
CREATE INDEX idx_events_key ON events_cache (marlon_key);

CREATE TABLE sync_state (
  calendar_id TEXT PRIMARY KEY,
  sync_token TEXT,
  last_sync_at TEXT
);

-- Horario PLANIFICADO (foto). Las horas reales irán en otra tabla (fase 4).
CREATE TABLE planned_shifts (
  date TEXT PRIMARY KEY,             -- YYYY-MM-DD (día de entrada)
  start_time TEXT NOT NULL,          -- HH:MM
  end_time TEXT NOT NULL,            -- HH:MM
  ends_next_day INTEGER NOT NULL DEFAULT 0,
  hours REAL NOT NULL,
  source_upload_id TEXT,
  event_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE schedule_uploads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'discarded')),
  raw_json TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  group_id TEXT
);

-- Historial de cambios en el calendario, con deshacer.
CREATE TABLE change_log (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor TEXT NOT NULL CHECK (actor IN ('marlon', 'user')),
  action TEXT NOT NULL CHECK (action IN ('create', 'move', 'update', 'delete')),
  event_id TEXT,
  summary TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  group_id TEXT,
  undone_at TEXT
);
CREATE INDEX idx_change_log_created ON change_log (created_at);
CREATE INDEX idx_change_log_group ON change_log (group_id);

-- Imágenes adjuntas pendientes de procesar. Se borran al usarlas o a las 24 h.
CREATE TABLE pending_images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,                -- base64
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
