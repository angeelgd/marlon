-- Banca abierta (PSD2) a través de Enable Banking: solo lectura.

-- Un permiso concedido en un banco (caduca a los 90-180 días según el banco).
CREATE TABLE bank_links (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  aspsp_name TEXT NOT NULL,
  aspsp_country TEXT NOT NULL,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE bank_accounts (
  uid TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES bank_links(id) ON DELETE CASCADE,
  iban TEXT,
  name TEXT,
  currency TEXT,
  balance_cents INTEGER,
  balance_at TEXT
);

-- Movimientos tal como vienen del banco. Los cargos ya contabilizados se pasan a expenses.
CREATE TABLE bank_transactions (
  id TEXT PRIMARY KEY,                 -- uid de la cuenta + referencia del banco
  account_uid TEXT NOT NULL,
  booking_date TEXT NOT NULL,          -- YYYY-MM-DD
  amount_cents INTEGER NOT NULL,       -- negativo = cargo, positivo = ingreso
  currency TEXT NOT NULL DEFAULT 'EUR',
  counterparty TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'pending')),
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'own_transfer')),
  expense_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_bank_tx_date ON bank_transactions (booking_date);
CREATE INDEX idx_bank_tx_account ON bank_transactions (account_uid, booking_date);

-- Lo que Ángel corrige se aprende: comercio normalizado -> categoría.
CREATE TABLE merchant_categories (
  merchant_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
