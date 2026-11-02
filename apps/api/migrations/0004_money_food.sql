-- Fase 4: dinero y comida

-- Reglas de pago con fecha de vigencia (editables desde la app, nunca en el código).
CREATE TABLE pay_rule_sets (
  id TEXT PRIMARY KEY,
  valid_from TEXT NOT NULL,           -- YYYY-MM-DD
  valid_to TEXT,                      -- YYYY-MM-DD, incluido
  rules_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Tabla vigente hasta el 30 de junio de 2027 (importes brutos en céntimos).
INSERT INTO pay_rule_sets (id, valid_from, valid_to, rules_json, note) VALUES (
  'rules_2027',
  '2020-01-01',
  '2027-06-30',
  '{"baseCents":1370,"eveningSupplementCents":140,"eveningFrom":"18:00","nightSupplementCents":237,"nightTo":"06:00","sundayHolidayMultiplier":2,"sundayNightConfirmed":false,"eveFrom":"15:00","eveMultiplier":1.5}',
  'Tabla inicial. Suben el 1 de julio de 2027.'
);

-- Horas REALES de trabajo. Separadas del horario planificado (planned_shifts):
-- una foto nueva del horario nunca las toca.
CREATE TABLE actual_shifts (
  date TEXT PRIMARY KEY,              -- día de entrada
  start_time TEXT,                    -- NULL + day_off = no fue a trabajar
  end_time TEXT,
  ends_next_day INTEGER NOT NULL DEFAULT 0,
  day_off INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,                 -- YYYY-MM-DD local
  amount_cents INTEGER NOT NULL,
  merchant TEXT,
  category TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'text',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_expenses_date ON expenses (date);

-- Sueldo, alquiler y gastos fijos mensuales.
CREATE TABLE budget_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'fixed')),
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  bucket TEXT CHECK (bucket IN ('needs', 'wants', 'savings')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Mensajes del chat con datos económicos: no se reenvían por la capa gratuita.
ALTER TABLE messages ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;

-- Mensaje con datos económicos esperando permiso para ir por la capa gratuita.
CREATE TABLE pending_consents (
  id TEXT PRIMARY KEY,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Recetas sacadas de vídeos de batch cooking.
CREATE TABLE recipes (
  video_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  channel TEXT,
  source TEXT NOT NULL CHECK (source IN ('video', 'description')),
  recipe_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Menú semanal y lista de la compra.
CREATE TABLE meal_plans (
  week_start TEXT PRIMARY KEY,        -- lunes
  plan_json TEXT NOT NULL,
  shopping_json TEXT NOT NULL,
  cooking_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
