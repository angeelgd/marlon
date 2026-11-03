-- Valores privados guardados desde la app (p. ej. la URL iCal de la uni).
-- Van cifrados con AES-GCM; la clave se deriva de SESSION_SECRET y nunca toca la base de datos.
CREATE TABLE secure_values (
  key TEXT PRIMARY KEY,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
