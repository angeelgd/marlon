-- Fase 3: pendientes, recordatorios y notificaciones push

CREATE TABLE pendings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'task', 'plan', 'birthday')),
  title TEXT NOT NULL,
  person TEXT,
  notes TEXT,
  area TEXT NOT NULL DEFAULT 'personal' CHECK (area IN ('work', 'uni', 'personal')),
  due_date TEXT,                     -- YYYY-MM-DD local
  due_time TEXT,                     -- HH:MM local
  birthday_md TEXT,                  -- MM-DD para cumpleaños (se repite cada año)
  horizon TEXT CHECK (horizon IN ('short', 'long')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  done_at TEXT,
  -- Insistencia gradual: cuántos avisos se han mandado y cuándo, por día.
  nudge_date TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  last_nudge_at TEXT,
  snoozed_until TEXT
);
CREATE INDEX idx_pendings_status ON pendings (status, due_date);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_success_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);

-- Cola de notificaciones. dedupe_key evita mandar dos veces lo mismo.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  send_at TEXT NOT NULL,             -- ISO UTC
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_notifications_due ON notifications (status, send_at);
